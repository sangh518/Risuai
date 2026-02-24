import { language } from "src/lang"
import { alertInput } from "../alert"

let auth:string = null
let authChecked = false

// Custom error class for database conflict detection
export class ConflictError extends Error {
    currentEtag: string
    constructor(message: string, currentEtag: string) {
        super(message)
        this.name = 'ConflictError'
        this.currentEtag = currentEtag
    }
}

export class NodeStorage{
    _lastDbEtag: string | null = null

    async setItem(key:string, value:Uint8Array, etag?:string) {
        await this.checkAuth()
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'file-path': Buffer.from(key, 'utf-8').toString('hex'),
            'risu-auth': auth
        }
        if (etag) {
            headers['x-if-match'] = etag
        }
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers
        })
        if(da.status === 409){
            const data = await da.json()
            throw new ConflictError(data.error, data.currentEtag)
        }
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        return nextEtag
    }
    async getItem(key:string):Promise<Buffer> {
        await this.checkAuth()
        const da = await fetch('/api/read', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        // Capture ETag for database.bin
        const etag = da.headers.get('x-db-etag')
        if (etag) {
            this._lastDbEtag = etag
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }

    /** Last known ETag for database.bin */
    setDbEtag(etag: string | null) {
        this._lastDbEtag = etag
    }
    async keys(prefix: string = ''): Promise<string[]> {
        await this.checkAuth()
        const da = await fetch('/api/list', {
            method: "GET",
            headers: {
                'risu-auth': auth,
                'key-prefix': prefix
            }
        })
        const data = await da.json()
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        await this.checkAuth()
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    async removeItems(keys: string[]) {
        await this.checkAuth()
        const keysHex = keys.map((key) => Buffer.from(key, 'utf-8').toString('hex'))

        const da = await fetch('/api/remove-bulk', {
            method: "POST",
            body: JSON.stringify(keysHex),
            headers: {
                'content-type': 'application/json',
                'risu-auth': auth
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItems Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<{success: boolean, etag?: string}> {
        await this.checkAuth()

        const da = await fetch('/api/patch', {
            method: "POST",
            body: JSON.stringify(patchData),
            headers: {
                'content-type': 'application/json',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
            }
        })

        if (da.status === 409) {
            const data = await da.json()
            const currentEtag = data.currentEtag as string | undefined
            if (key === 'database/database.bin' && currentEtag) {
                this._lastDbEtag = currentEtag
            }
            return { success: false, etag: currentEtag }
        }
        if (da.status < 200 || da.status >= 300) {
            return { success: false }
        }
        const data = await da.json()
        if (data.error) {
            return { success: false }
        }
        const nextEtag = data.etag as string | undefined
        if (key === 'database/database.bin' && nextEtag) {
            this._lastDbEtag = nextEtag
        }
        return { success: true, etag: nextEtag }
    }

    private async checkAuth() {
        if(!auth){
            auth = localStorage.getItem('risuauth')
        }

        if(!authChecked){
            const data = await (await fetch('/api/password',{
                headers: {
                    'risu-auth': auth ?? ''
                }
            })).json()

            if(data.status === 'unset'){
                const input = await digestPassword(await alertInput(language.setNodePassword))
                await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                auth = input
                localStorage.setItem('risuauth', auth)
            }
            else if(data.status === 'incorrect'){
                while(true){
                    const input = await digestPassword(await alertInput(language.inputNodePassword))
                    const data = await (await fetch('/api/password',{
                        headers: {
                            'risu-auth': input ?? ''
                        }
                    })).json()
                    if(data.status !== 'unset'){
                        auth = input
                        localStorage.setItem('risuauth', auth)
                        await this.checkAuth()
                        break
                    }
                }
            }
            else{
                authChecked = true
            }
        }
    }

    getAuth():string{
        return auth
    }

    listItem = this.keys
}

async function digestPassword(message:string) {
    const crypt = await (await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })).text()
    
    return crypt;
}
