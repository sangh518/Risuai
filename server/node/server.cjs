const express = require('express');
const compression = require('compression');
const app = express();
const path = require('path');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const crypto = require('crypto')
const { applyPatch } = require('fast-json-patch')
const {
    decodeRisuSave,
    encodeRisuSaveLegacy,
    calculateHash,
    normalizeJSON,
} = require('./utils.cjs')

app.use(compression({
    filter: (req, res) => {
        const type = res.getHeader('Content-Type');
        if (type === 'application/octet-stream') return true;
        return compression.filter(req, res);
    }
}));
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
const {pipeline} = require('stream/promises')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
const openid = require('openid-client');

let password = ''

// Configuration flags for patch-based sync
let enablePatchSync = true
const [nodeMajor, nodeMinor, nodePatch] = process.version.slice(1).split('.').map(Number);
// v22.7.0, v23 and above have a bug with msgpackr that causes it to crash on encoding risu saves
if (nodeMajor >= 23 || (nodeMajor === 22 && nodeMinor === 7 && nodePatch === 0)) {
    console.log(`[Server] Detected problematic Node.js version ${process.version}. Disabling patch-based sync.`);
    enablePatchSync = false;
}

// In-memory database cache for patch-based sync
let dbCache = {}
let saveTimers = {}
const SAVE_INTERVAL = 5000 // Save to disk after 5 seconds of inactivity

// ETag for database.bin to detect concurrent modification conflicts
let dbEtag = null

function computeBufferEtag(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex');
}

function computeDatabaseEtagFromObject(databaseObject) {
    return computeBufferEtag(Buffer.from(encodeRisuSaveLegacy(databaseObject)));
}

let storageOperationQueue = Promise.resolve();
function queueStorageOperation(operation) {
    const operationRun = storageOperationQueue.then(operation, operation);
    storageOperationQueue = operationRun.catch(() => {});
    return operationRun;
}

const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const hexRegex = /^[0-9a-fA-F]+$/;
function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

app.get('/', async (req, res, next) => {

    const clientIP = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = ${enablePatchSync}</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

const reverseProxyFunc = async (req, res, next) => {
    const authHeader = req.headers['risu-auth'];
    if(!authHeader || authHeader.trim() !== password.trim()){
        console.log('incorrect', 'received:', authHeader, 'expected:', password)
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = fs.readFileSync(authCodePath, 'utf-8')
            header['authorization'] = `Bearer ${authCode}`
        }
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body)
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);


    }
    catch (err) {
        next(err);
        return;
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    const authHeader = req.headers['risu-auth'];
    if(!authHeader || authHeader.trim() !== password.trim()){
        console.log('incorrect', 'received:', authHeader, 'expected:', password)
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        next(err);
        return;
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        let externalURL = '';

        const pathHeader = req.headers['x-risu-node-path'];
        if (pathHeader) {
            const decodedPath = decodeURIComponent(pathHeader);
            externalURL = decodedPath;
        } else {
            const pathAndQuery = req.originalUrl.replace(/^\/hub-proxy/, '');
            externalURL = hubURL + pathAndQuery;
        }
        
        const headersToSend = { ...req.headers };
        delete headersToSend.host;
        delete headersToSend.connection;
        delete headersToSend['content-length'];
        delete headersToSend['x-risu-node-path'];

        const hubOrigin = new URL(hubURL).origin;
        headersToSend.origin = hubOrigin;

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(headersToSend['Authorization'] === 'X-Node-Server-Auth'){
            //this requires password auth
            const authHeader = req.headers['risu-auth'];
            if(!authHeader || authHeader.trim() !== password.trim()){
                console.log('incorrect', 'received:', authHeader, 'expected:', password)
                throw new Error('Incorrect password for server auth');
            }

            headersToSend['Authorization'] = "Bearer " + await getSionywAccessToken();
            delete headersToSend['risu-auth'];
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = response.headers.get('location');
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        console.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.get('/proxy', reverseProxyFunc_get);
app.get('/proxy2', reverseProxyFunc_get);
app.get('/hub-proxy/*', hubProxyFunc);

app.post('/proxy', reverseProxyFunc);
app.post('/proxy2', reverseProxyFunc);
app.post('/hub-proxy/*', hubProxyFunc);

app.get('/api/password', async(req, res)=> {
    if(password === ''){
        res.send({status: 'unset'})
    }
    else if(req.headers['risu-auth']  === password){
        res.send({status:'correct'})
    }
    else{
        res.send({status:'incorrect'})
    }
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = crypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        next(error)
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === ''){
        password = req.body.password
        writeFileSync(passwordPath, password, 'utf-8')
    }
    res.status(400).send("already set")
})

app.get('/api/read', async (req, res, next) => {
    if(req.headers['risu-auth'].trim() !== password.trim()){
        console.log('incorrect')
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({
            error:'File path required'
        });
        return;
    }

    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }
    try {
        await queueStorageOperation(async () => {
            const fullPath = path.join(savePath, filePath);
            const decodedFilePath = Buffer.from(filePath, 'hex').toString('utf-8');

            // Stop any pending save timer for this file
            if(saveTimers[filePath]){
                clearTimeout(saveTimers[filePath]);
                delete saveTimers[filePath];
            }

            // Write to disk if available in cache
            if(dbCache[filePath]){
                try {
                    let dataToSave = encodeRisuSaveLegacy(dbCache[filePath]);
                    await fs.writeFile(fullPath, dataToSave);
                } catch (error) {
                    console.error(`[Read] Error saving ${filePath}:`, error);
                }
                delete dbCache[filePath];
            }

            // Read from disk
            if(!existsSync(fullPath)){
                res.send();
            } else {
                res.setHeader('Content-Type', 'application/octet-stream');
                // For database.bin, compute and return ETag
                if (decodedFilePath === 'database/database.bin') {
                    const content = await fs.readFile(fullPath);
                    dbEtag = computeBufferEtag(content);
                    res.setHeader('X-Db-Etag', dbEtag);
                    res.send(content);
                } else {
                    res.sendFile(fullPath);
                }
            }
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', async (req, res, next) => {
    if(req.headers['risu-auth'].trim() !== password.trim()){
        console.log('incorrect')
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await fs.rm(path.join(savePath, filePath));
        res.send({
            success: true,
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/remove-bulk', async (req, res, next) => {
    if(req.headers['risu-auth'].trim() !== password.trim()){
        console.log('incorrect')
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    const filePaths = req.body;
    if (!filePaths || !Array.isArray(filePaths)) {
        res.status(400).send({
            error: 'File paths array required'
        });
        return;
    }

    try {
        const validFiles = filePaths.filter(filePath => isHex(filePath));
        const BATCH_SIZE = 100;

        for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
            const batch = validFiles.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(f => fs.rm(path.join(savePath, f), { force: true })));
        }

        res.send({
            success: true,
        });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', async (req, res, next) => {
    if(req.headers['risu-auth'].trim() !== password.trim()){
        console.log('incorrect')
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    try {
        const prefix = (req.headers['key-prefix'] || '').trim();
        const data = (await fs.readdir(path.join(savePath)))
            .map((v) => { return Buffer.from(v, 'hex').toString('utf-8') })
            .filter((v) => { return !prefix || v.startsWith(prefix) })

        res.send({
            success: true,
            content: data
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', async (req, res, next) => {
    if(req.headers['risu-auth'].trim() !== password.trim()){
        console.log('incorrect')
        res.status(400).send({
            error:'Password Incorrect'
        });
        return
    }
    const filePath = req.headers['file-path'];
    const fileContent = req.body
    if (!filePath || !fileContent) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }

    try {
        await queueStorageOperation(async () => {
            const decodedFilePath = Buffer.from(filePath, 'hex').toString('utf-8');

            // ETag-based conflict detection for database.bin
            const ifMatch = req.headers['x-if-match'];
            if (decodedFilePath === 'database/database.bin' && ifMatch && dbEtag) {
                if (ifMatch !== dbEtag) {
                    console.log(`[Write] Version conflict for database.bin: client=${ifMatch}, server=${dbEtag}`);
                    res.status(409).send({
                        error: 'Conflict: database has been modified by another device',
                        currentEtag: dbEtag
                    });
                    return;
                }
            }

            await fs.writeFile(path.join(savePath, filePath), fileContent);

            // Update ETag for database.bin after successful write
            if (decodedFilePath === 'database/database.bin') {
                dbEtag = computeBufferEtag(fileContent);
            }

            // Clear any pending save timer for this file
            if (saveTimers[filePath]) {
                clearTimeout(saveTimers[filePath]);
                delete saveTimers[filePath];
            }

            // Clear cache for this file since it was directly written
            if (dbCache[filePath]) delete dbCache[filePath];

            res.send({
                success: true,
                etag: decodedFilePath === 'database/database.bin' ? dbEtag : undefined
            });
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/patch', async (req, res, next) => {
    // Check if patch sync is enabled
    if (!enablePatchSync) {
        res.status(404).send({
            error: 'Patch sync is not enabled'
        });
        return;
    }

    if (req.headers['risu-auth'].trim() !== password.trim()) {
        console.log('incorrect')
        res.status(400).send({
            error: 'Password Incorrect'
        });
        return
    }
    const filePath = req.headers['file-path'];
    const patch = req.body.patch;
    const expectedHash = req.body.expectedHash;

    if (!filePath || !patch || !expectedHash) {
        res.status(400).send({
            error: 'File path, patch, and expected hash required'
        });
        return;
    }
    if (!isHex(filePath)) {
        res.status(400).send({
            error: 'Invaild Path'
        });
        return;
    }

    try {
        await queueStorageOperation(async () => {
            const decodedFilePath = Buffer.from(filePath, 'hex').toString('utf-8');

            // Load database into memory if not already cached
            if (!dbCache[filePath]) {
                const fullPath = path.join(savePath, filePath);
                if (existsSync(fullPath)) {
                    const fileContent = await fs.readFile(fullPath);
                    dbCache[filePath] = normalizeJSON(await decodeRisuSave(fileContent));
                }
                else {
                    dbCache[filePath] = {};
                }
            }

            const serverHash = calculateHash(dbCache[filePath]).toString(16);

            if (expectedHash !== serverHash) {
                console.log(`[Patch] Hash mismatch for ${decodedFilePath}: expected=${expectedHash}, server=${serverHash}`);
                let currentEtag = undefined;
                if (decodedFilePath === 'database/database.bin') {
                    currentEtag = computeDatabaseEtagFromObject(dbCache[filePath]);
                    dbEtag = currentEtag;
                }
                res.status(409).send({
                    error: 'Hash mismatch - data out of sync',
                    currentEtag
                });
                return;
            }

            // Apply patch to in-memory database
            const result = applyPatch(dbCache[filePath], patch, true);

            // Schedule save to disk (debounced)
            if (saveTimers[filePath]) {
                clearTimeout(saveTimers[filePath]);
            }
            saveTimers[filePath] = setTimeout(async () => {
                try {
                    const fullPath = path.join(savePath, filePath);
                    let dataToSave = encodeRisuSaveLegacy(dbCache[filePath]);
                    await fs.writeFile(fullPath, dataToSave);
                    // Create backup for database files after successful save
                    if (decodedFilePath.includes('database/database.bin')) {
                        try {
                            const timestamp = Math.floor(Date.now() / 100).toString();
                            const backupFileName = `database/dbbackup-${timestamp}.bin`;
                            const backupFilePath = Buffer.from(backupFileName, 'utf-8').toString('hex');
                            const backupFullPath = path.join(savePath, backupFilePath);
                            // Create backup using the same data that was just saved
                            await fs.writeFile(backupFullPath, dataToSave);
                        } catch (backupError) {
                            console.error(`[Patch] Error creating backup:`, backupError);
                        }
                    }
                } catch (error) {
                    console.error(`[Patch] Error saving ${filePath}:`, error);
                } finally {
                    delete saveTimers[filePath];
                }
            }, SAVE_INTERVAL);

            // Update ETag after successful patch
            if (decodedFilePath === 'database/database.bin') {
                dbEtag = computeDatabaseEtagFromObject(dbCache[filePath]);
            }

            res.send({
                success: true,
                appliedOperations: result.length,
                etag: decodedFilePath === 'database/database.bin' ? dbEtag : undefined,
            });
        });
    } catch (error) {
        console.error(`[Patch] Error applying patch to ${filePath}:`, error.name);
        res.status(500).send({
            error: 'Patch application failed: ' + (error && error.message ? error.message : error)
        });
    }
});

const oauthData = {
    client_id: '',
    client_secret: '',
    config: {},
    code_verifier: ''

}
app.get('/api/oauth_login', async (req, res) => {
    const redirect_uri = (new URL (req.url)).host + '/api/oauth_callback'

    if(!redirect_uri){
        res.status(400).send({ error: 'redirect_uri is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret){
        const discovery = await openid.discovery('https://account.sionyw.com/','','');
        oauthData.config = discovery;

        //oauth dynamic client registration
        //https://datatracker.ietf.org/doc/html/rfc7591

        const serverMeta = discovery.serverMetadata()
        //since we can't find a good library to do this, we will do it manually
        const registrationResponse = await fetch(serverMeta.registration_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (serverMeta.registration_access_token || '')
            },
            body: JSON.stringify({
                client_id: oauthData.client_id,
                client_secret: oauthData.client_secret,
                redirect_uris: [redirect_uri],
                response_types: ['code'],
                grant_types: ['authorization_code'],
                scope: 'risuai',
                token_endpoint_auth_method: 'client_secret_basic',
                client_name: 'Risuai Node Server',
            })
        });

        if(registrationResponse.status === 201 || registrationResponse.status === 200){
            const registrationData = await registrationResponse.json();
            oauthData.client_id = registrationData.client_id;
            oauthData.client_secret = registrationData.client_secret;
            discovery.clientMetadata().client_id = oauthData.client_id;
            discovery.clientMetadata().client_secret = oauthData.client_secret;
        }
        else{
            console.error('[Server] OAuth2 dynamic client registration failed:', registrationResponse.statusText);
            res.status(500).send({ error: 'OAuth2 client registration failed' });
            return
        }


        //now lets request

        let code_verifier = openid.randomPKCECodeVerifier();
        let code_challenge = await openid.calculatePKCECodeChallenge(code_verifier);

        oauthData.code_verifier = code_verifier;
        let redirectTo = openid.buildAuthorizationUrl(oauthData.config, {
            redirect_uri,
            code_challenge,
            code_challenge_method: 'S256',
            scope: 'risuai',
        })

        res.redirect(redirectTo.toString());

        return;

    }
    
    res.status(500).send({ error: 'OAuth2 login failed' });
});

app.get('/api/oauth_callback', async (req, res) => {

    //since this is a callback we don't need to check password

    const params = (new URL(req.url, `http://${req.headers.host}`)).searchParams;
    const code = params.get('code');

    if(!code){
        res.status(400).send({ error: 'code is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret || !oauthData.code_verifier){
        res.status(400).send({ error: 'OAuth2 not initialized' });
        return
    }

    let tokens = await openid.authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    fs.writeFileSync(authCodePath, tokens.access_token, 'utf-8')

    res.send(tokens)
            
})

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
}

async function startServer() {
    try {
      
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();

        if (httpsOptions) {
            // HTTPS
            https.createServer(httpsOptions, app).listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
                console.log(`[Server] Patch sync: ${enablePatchSync ? 'ENABLED' : 'DISABLED'}`);
            });
        } else {
            // HTTP
            app.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
                console.log(`[Server] Patch sync: ${enablePatchSync ? 'ENABLED' : 'DISABLED'}`);
            });
        }
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

(async () => {
    await startServer();
})();
