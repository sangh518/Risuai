import localforage from "localforage";
import { getCurrentCharacter } from "../../storage/database.svelte";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "../../storage/nodeStorage";

const INLAY_META_PREFIX = 'inlay_meta/'

export type InlayAssetMeta = {
    createdAt: number
    updatedAt: number
    charId?: string
    chatId?: string
}

class NodeInlayMetaStorage {
    private nodeStorage = new NodeStorage()

    private serverKey(id: string): string {
        return `${INLAY_META_PREFIX}${id}`
    }

    async setItem(id: string, meta: InlayAssetMeta): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(meta))
        await this.nodeStorage.setItem(this.serverKey(id), bytes)
    }

    async getItem(id: string): Promise<InlayAssetMeta | null> {
        try {
            const buf = await this.nodeStorage.getItem(this.serverKey(id))
            if (!buf || buf.length === 0) return null
            const raw = JSON.parse(new TextDecoder().decode(buf))
            const createdAt = typeof raw?.createdAt === 'number' ? raw.createdAt : 0
            const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : createdAt
            const charId = typeof raw?.charId === 'string' ? raw.charId : undefined
            const chatId = typeof raw?.chatId === 'string' ? raw.chatId : undefined
            return { createdAt, updatedAt, charId, chatId }
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try {
            await this.nodeStorage.removeItem(this.serverKey(id))
        } catch {
            // ignore
        }
    }

    async entries(): Promise<[string, InlayAssetMeta][]> {
        const allKeys = await this.nodeStorage.keys(INLAY_META_PREFIX)
        const entries: [string, InlayAssetMeta][] = []
        const ids = allKeys.map((decodedKey) => decodedKey.replace(INLAY_META_PREFIX, ''))
        const batchSize = 200
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize)
            const metas = await Promise.all(batch.map(async (id) => {
                try {
                    return await this.getItem(id)
                } catch {
                    return null
                }
            }))
            for (let j = 0; j < batch.length; j++) {
                const meta = metas[j]
                if (meta) entries.push([batch[j], meta])
            }
        }
        return entries
    }
}

const localInlayMetaStorage = localforage.createInstance({
    name: 'inlay_meta',
    storeName: 'inlay_meta'
})

let _nodeInlayMetaStorage: NodeInlayMetaStorage | null = null

function getNodeInlayMetaStorage(): NodeInlayMetaStorage {
    if (!_nodeInlayMetaStorage) {
        _nodeInlayMetaStorage = new NodeInlayMetaStorage()
    }
    return _nodeInlayMetaStorage
}

export async function setInlayMeta(id: string, meta: InlayAssetMeta): Promise<void> {
    if (isNodeServer) {
        await getNodeInlayMetaStorage().setItem(id, meta)
        return
    }
    await localInlayMetaStorage.setItem(id, meta)
}

export async function removeInlayMeta(id: string): Promise<void> {
    if (isNodeServer) {
        await getNodeInlayMetaStorage().removeItem(id)
        return
    }
    await localInlayMetaStorage.removeItem(id)
}

export async function listInlayMetaEntries(): Promise<[string, InlayAssetMeta][]> {
    if (isNodeServer) {
        return await getNodeInlayMetaStorage().entries()
    }
    const entries: [string, InlayAssetMeta][] = []
    await localInlayMetaStorage.iterate<InlayAssetMeta, void>((value, key) => {
        const createdAt = typeof value?.createdAt === 'number' ? value.createdAt : 0
        const updatedAt = typeof value?.updatedAt === 'number' ? value.updatedAt : createdAt
        const charId = typeof value?.charId === 'string' ? value.charId : undefined
        const chatId = typeof value?.chatId === 'string' ? value.chatId : undefined
        entries.push([key, { createdAt, updatedAt, charId, chatId }])
    })
    return entries
}

export async function getInlayMeta(id: string): Promise<InlayAssetMeta | null> {
    let meta: InlayAssetMeta | null = null
    if (isNodeServer) {
        meta = await getNodeInlayMetaStorage().getItem(id)
    } else {
        const raw = await localInlayMetaStorage.getItem<InlayAssetMeta | null>(id)
        if (raw) {
            meta = {
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
                updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : (typeof raw.createdAt === 'number' ? raw.createdAt : 0),
                charId: typeof raw.charId === 'string' ? raw.charId : undefined,
                chatId: typeof raw.chatId === 'string' ? raw.chatId : undefined,
            }
        }
    }
    return meta
}

export function buildInlayMeta(existingMeta?: InlayAssetMeta | null): InlayAssetMeta {
    const now = Date.now()
    const currentChar = getCurrentCharacter()
    const currentCharId = typeof currentChar?.chaId === 'string' ? currentChar.chaId : undefined
    const currentChat = currentChar?.chats?.[currentChar?.chatPage ?? 0]
    const currentChatId = typeof currentChat?.id === 'string' ? currentChat.id : undefined

    const createdAt =
        (existingMeta?.createdAt && existingMeta.createdAt > 0) ? existingMeta.createdAt :
        now
    const updatedAt = now
    const charId =
        (existingMeta?.charId && existingMeta.charId.length > 0) ? existingMeta.charId :
        currentCharId
    const chatId =
        (existingMeta?.chatId && existingMeta.chatId.length > 0) ? existingMeta.chatId :
        currentChatId

    return { createdAt, updatedAt, charId, chatId }
}
