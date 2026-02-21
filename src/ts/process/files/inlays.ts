import localforage from "localforage";
import { v4 } from "uuid";
import { getImageType } from "src/ts/media";
import { getDatabase } from "../../storage/database.svelte";
import { getModelInfo, LLMFlags } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "../../storage/nodeStorage";
import {
    type InlayAssetMeta,
    buildInlayMeta,
    getInlayMeta,
    removeInlayMeta,
    setInlayMeta,
} from "./inlayMeta";

export type InlayAsset = {
    data: string | Blob
    /** File extension */
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio'
    width?: number
}

/** Common interface for Inlay storage backends */
interface IInlayStorage {
    setItem(key: string, value: any): Promise<any>
    getItem<T>(key: string): Promise<T | null>
    removeItem(key: string): Promise<void>
    iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U): Promise<U>
    keys(): Promise<string[]>
}

/** Serialized form for server storage (Blob → base64 string) */
type SerializedInlayAsset = {
    data: string
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio'
    width?: number
}

export type InlayThumbnail = {
    data: string
    ext: string
    height?: number
    name: string
    type: 'image'
    width?: number
}

const inlayImageExts = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'
]

const inlayAudioExts = [
    'wav', 'mp3', 'ogg', 'flac'
]

const inlayVideoExts = [
    'webm', 'mp4', 'mkv'
]

const INLAY_PREFIX = 'inlay/'
const INLAY_THUMB_PREFIX = 'inlay_thumb/'

// ── Node server Inlay storage adapter ──
// Provides a localforage-compatible interface backed by server CRUD API

class NodeInlayStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_PREFIX}${id}`
    }

    private async serializeAsset(asset: InlayAsset): Promise<Uint8Array> {
        let dataStr: string
        if (asset.data instanceof Blob) {
            dataStr = await blobToBase64(asset.data)
        } else {
            dataStr = asset.data as string
        }
        const serialized: SerializedInlayAsset = {
            data: dataStr,
            ext: asset.ext,
            height: asset.height,
            name: asset.name,
            type: asset.type,
            width: asset.width,
        }
        return new TextEncoder().encode(JSON.stringify(serialized))
    }

    private deserializeAsset(buf: Buffer): InlayAsset {
        const json: SerializedInlayAsset = JSON.parse(new TextDecoder().decode(buf))
        let data: string | Blob
        // Convert base64 data URI back to Blob for image/video/audio
        if (json.data.startsWith('data:')) {
            data = base64ToBlob(json.data)
        } else {
            data = json.data
        }
        return {
            data,
            ext: json.ext,
            height: json.height,
            name: json.name,
            type: json.type,
            width: json.width,
        }
    }

    async setItem(id: string, asset: InlayAsset): Promise<void> {
        const bytes = await this.serializeAsset(asset)
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem<T>(id: string): Promise<T | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            return this.deserializeAsset(buf) as unknown as T
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
        } catch {
            // ignore if not found
        }
    }

    async keys(): Promise<string[]> {
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        return allKeys.map(k => k.replace(INLAY_PREFIX, ''))
    }

    async iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
        // NodeStorage.keys() already returns decoded UTF-8 keys (e.g. "inlay/uuid"),
        // NOT hex-encoded filenames. No need to hex-decode again.
        const allKeys = await this.nodeStorage.keys(INLAY_PREFIX)
        let result: U
        let i = 0
        for (const decodedKey of allKeys) {
            const id = decodedKey.replace(INLAY_PREFIX, '')
            try {
                // NodeStorage.getItem() internally hex-encodes the key for the server
                const buf = await this.nodeStorage.getItem(decodedKey)
                if (buf && buf.length > 0) {
                    const asset = this.deserializeAsset(buf)
                    result = callback(asset as unknown as T, id, i)
                    i++
                }
            } catch {
                // skip corrupt entries
            }
        }
        return result
    }
}

class NodeInlayThumbStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_THUMB_PREFIX}${id}`
    }

    async setItem(id: string, thumb: InlayThumbnail): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(thumb))
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem<T>(id: string): Promise<T | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            const json = JSON.parse(new TextDecoder().decode(buf))
            return json as T
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
        } catch {
            // ignore if not found
        }
    }
}

function toCoreInlayAsset(asset: any): InlayAsset {
    return {
        data: asset.data,
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: asset.type,
        width: asset.width,
    }
}

// ── Storage instance management ──

const localInlayStorage = localforage.createInstance({
    name: 'inlay',
    storeName: 'inlay'
})

const localInlayThumbStorage = localforage.createInstance({
    name: 'inlay_thumb',
    storeName: 'inlay_thumb'
})

let _nodeInlayStorage: NodeInlayStorage | null = null
let _nodeInlayThumbStorage: NodeInlayThumbStorage | null = null
let _migrationDone = false

function getInlayStorage(): IInlayStorage {
    if (isNodeServer) {
        if (!_nodeInlayStorage) {
            _nodeInlayStorage = new NodeInlayStorage()
        }
        return _nodeInlayStorage
    }
    return localInlayStorage
}

function getInlayThumbStorage() {
    if (isNodeServer) {
        if (!_nodeInlayThumbStorage) {
            _nodeInlayThumbStorage = new NodeInlayThumbStorage()
        }
        return _nodeInlayThumbStorage
    }
    return localInlayThumbStorage
}

export { getInlayMeta } from "./inlayMeta";

/**
 * Migrate existing local (IndexedDB) Inlay assets to the Node server.
 * Should be called once during app initialization when running on Node server.
 */
export async function migrateLocalInlaysToServer(): Promise<number> {
    if (!isNodeServer || _migrationDone) return 0
    _migrationDone = true

    const migrationFlag = localStorage.getItem('inlay_migrated_to_server')
    if (migrationFlag === 'done') return 0

    const serverStorage = getInlayStorage() as NodeInlayStorage

    try {
        // Collect all local inlay entries first
        const entries: { key: string, value: InlayAsset }[] = []
        await localInlayStorage.iterate<InlayAsset, void>((value, key) => {
            entries.push({ key, value })
        })

        if (entries.length === 0) {
            localStorage.setItem('inlay_migrated_to_server', 'done')
            return 0
        }

        // Upload each entry to server
        for (const { key, value } of entries) {
            await serverStorage.setItem(key, value)
        }

        localStorage.setItem('inlay_migrated_to_server', 'done')
        console.log(`[Inlay] Migrated ${entries.length} assets to server`)
        return entries.length
    } catch (e) {
        console.error('[Inlay] Migration failed:', e)
    }

    return 0
}

export async function postInlayAsset(img:{
    name:string,
    data:Uint8Array
}){

    const extention = img.name.split('.').at(-1)
    const imgObj = new Image()

    if(inlayImageExts.includes(extention)){
        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img.data)], {type: `image/${extention}`}))

        return await writeInlayImage(imgObj, {
            name: img.name,
            ext: extention
        })
    }

    if(inlayAudioExts.includes(extention)){
        const audioBlob = new Blob([asBuffer(img.data)], {type: `audio/${extention}`})
        const imgid = v4()

        await setInlayAsset(imgid, {
            name: img.name,
            data: audioBlob,
            ext: extention,
            type: 'audio'
        })

        return `${imgid}`
    }

    if(inlayVideoExts.includes(extention)){
        const videoBlob = new Blob([asBuffer(img.data)], {type: `video/${extention}`})
        const imgid = v4()

        await setInlayAsset(imgid, {
            name: img.name,
            data: videoBlob,
            ext: extention,
            type: 'video'
        })

        return `${imgid}`
    }

    return null
}

export async function writeInlayImage(imgObj:HTMLImageElement, arg:{name?:string, ext?:string, id?:string} = {}) {

    let drawHeight = 0
    let drawWidth = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    await new Promise((resolve) => {
        imgObj.onload = () => {
            drawHeight = imgObj.height
            drawWidth = imgObj.width

            //resize image to fit inlay, if total pixels exceed 1024*1024
            const maxPixels = 1024 * 1024
            const currentPixels = drawHeight * drawWidth
            
            if(currentPixels > maxPixels){
                const scaleFactor = Math.sqrt(maxPixels / currentPixels)
                drawWidth = Math.floor(drawWidth * scaleFactor)
                drawHeight = Math.floor(drawHeight * scaleFactor)
            }

            canvas.width = drawWidth
            canvas.height = drawHeight
            ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
            resolve(null)
        }
    })
    const imageBlob = await new Promise<Blob>(resolve => canvas.toBlob(resolve, 'image/png'));


    const imgid = arg.id ?? v4()

    await setInlayAsset(imgid, {
        name: arg.name ?? imgid,
        data: imageBlob,
        ext: 'png',
        height: drawHeight,
        width: drawWidth,
        type: 'image'
    })

    return `${imgid}`
}

function base64ToBlob(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];

    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.onerror = reject;
    });
}

async function buildThumbnailDataUrl(asset: InlayAsset, maxSide = 512, quality = 0.84): Promise<string | null> {
    if (asset.type !== 'image') return null

    let src = ''
    let revokeUrl = ''
    try {
        if (asset.data instanceof Blob) {
            revokeUrl = URL.createObjectURL(asset.data)
            src = revokeUrl
        } else if (typeof asset.data === 'string') {
            src = asset.data
        }
        if (!src) return null

        const img = new Image()
        img.decoding = 'async'
        img.src = src
        if (img.decode) {
            await img.decode()
        } else {
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve()
                img.onerror = () => reject(new Error('thumbnail decode failed'))
            })
        }

        const w = img.naturalWidth || img.width || 0
        const h = img.naturalHeight || img.height || 0
        if (!w || !h) return null

        const ratio = Math.min(1, maxSide / Math.max(w, h))
        const tw = Math.max(1, Math.round(w * ratio))
        const th = Math.max(1, Math.round(h * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = tw
        canvas.height = th
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(img, 0, 0, tw, th)

        try {
            return canvas.toDataURL('image/webp', quality)
        } catch {
            return canvas.toDataURL('image/jpeg', quality)
        }
    } catch {
        return null
    } finally {
        if (revokeUrl) URL.revokeObjectURL(revokeUrl)
    }
}

async function buildInlayThumbnail(asset: InlayAsset): Promise<InlayThumbnail | null> {
    if (asset.type !== 'image') return null
    const data = await buildThumbnailDataUrl(asset)
    if (!data) return null
    return {
        data,
        ext: asset.ext,
        height: asset.height,
        name: asset.name,
        type: 'image',
        width: asset.width,
    }
}

// Returns with base64 data URI
export async function getInlayAsset(id: string){
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: string;
    if(img.data instanceof Blob){
        data = await blobToBase64(img.data)
    } else {
        data = img.data as string
    }

    return { ...toCoreInlayAsset(img), data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string){
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: Blob;
    if(typeof img.data === 'string'){
        // Migrate to Blob
        data = base64ToBlob(img.data)
        await setInlayAsset(id, { ...toCoreInlayAsset(img), data })
    } else {
        data = img.data
    }

    return { ...toCoreInlayAsset(img), data }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
    const assets: [id: string, InlayAsset][] = []
    await getInlayStorage().iterate<InlayAsset, void>((value, key) => {
        assets.push([key, toCoreInlayAsset(value)])
    })

    return assets
}

export async function listInlayKeys(): Promise<string[]> {
    // Keep this API lightweight: key-only listing without metadata reads.
    return await getInlayStorage().keys()
}

export async function setInlayAsset(id: string, img: InlayAsset){
    const storage = getInlayStorage()
    const existingMeta = await getInlayMeta(id)
    const nextMeta = buildInlayMeta(existingMeta)
    await storage.setItem(id, toCoreInlayAsset(img))
    await setInlayMeta(id, nextMeta)
    const thumb = await buildInlayThumbnail(toCoreInlayAsset(img))
    if (thumb) {
        await getInlayThumbStorage().setItem(id, thumb)
    } else {
        await getInlayThumbStorage().removeItem(id)
    }
}

export async function removeInlayAsset(id: string){
    await getInlayStorage().removeItem(id)
    await removeInlayMeta(id)
    await getInlayThumbStorage().removeItem(id)
}

export async function removeInlayAssets(ids: string[]): Promise<number> {
    if (!Array.isArray(ids) || ids.length === 0) return 0

    let removed = 0
    for (const id of ids) {
        if (!id) continue
        try {
            await removeInlayAsset(id)
            removed++
        } catch {
            // continue best-effort for bulk delete
        }
    }
    return removed
}

export async function setInlayMetaFields(
    id: string,
    patch: Partial<Pick<InlayAssetMeta, 'charId' | 'chatId' | 'createdAt' | 'updatedAt'>>
): Promise<void> {
    const existing = await getInlayMeta(id)
    const now = Date.now()
    const next: InlayAssetMeta = {
        createdAt: (typeof patch.createdAt === 'number' && patch.createdAt > 0)
            ? patch.createdAt
            : (existing?.createdAt && existing.createdAt > 0 ? existing.createdAt : now),
        updatedAt: (typeof patch.updatedAt === 'number' && patch.updatedAt > 0)
            ? patch.updatedAt
            : now,
        charId: typeof patch.charId === 'string' ? patch.charId : existing?.charId,
        chatId: typeof patch.chatId === 'string' ? patch.chatId : existing?.chatId,
    }
    await setInlayMeta(id, next)
}

export async function getInlayMetas(ids: string[]): Promise<Record<string, InlayAssetMeta>> {
    const result: Record<string, InlayAssetMeta> = {}
    if (!Array.isArray(ids) || ids.length === 0) return result

    const batchSize = 200
    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize)
        const metas = await Promise.all(batch.map(async (id) => {
            try {
                return await getInlayMeta(id)
            } catch {
                return null
            }
        }))
        for (let j = 0; j < batch.length; j++) {
            const meta = metas[j]
            if (meta) {
                result[batch[j]] = meta
            }
        }
    }
    return result
}

export async function getInlayListItem(id: string): Promise<InlayAsset | null> {
    const thumb = await getInlayThumbStorage().getItem<InlayThumbnail | null>(id)
    if (thumb && typeof thumb.data === 'string' && thumb.data.startsWith('data:')) {
        return {
            data: thumb.data,
            ext: thumb.ext,
            height: thumb.height,
            name: thumb.name || id,
            type: 'image',
            width: thumb.width,
        }
    }

    const full = await getInlayAsset(id)
    if (!full) return null

    if (full.type === 'image') {
        const coreFull = toCoreInlayAsset(full)
        const generatedThumb = await buildInlayThumbnail(coreFull)
        if (generatedThumb) {
            await getInlayThumbStorage().setItem(id, generatedThumb)
            return {
                data: generatedThumb.data,
                ext: generatedThumb.ext,
                height: generatedThumb.height,
                name: generatedThumb.name || id,
                type: 'image',
                width: generatedThumb.width,
            }
        }
    }

    return full
}

export function supportsInlayImage(){
    const db = getDatabase()
    return getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput)
}

export async function reencodeImage(img:Uint8Array){
    if(getImageType(img) === 'PNG'){
        return img
    }
    const canvas = document.createElement('canvas')
    const imgObj = new Image()
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/png`}))
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
}
