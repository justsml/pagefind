// Web Worker for offloading search operations from the main thread

declare var wasm_bindgen: any;
declare var pagefind_version: string;

// Since types are globally declared, we don't need to import or redefine them
// They're available as PagefindSearchOptions and PagefindSearchResults

interface WorkerMessage {
    id: string;
    type: 'init' | 'search' | 'filter' | 'preload';
    payload: any;
}

interface WorkerResponse {
    id: string;
    type: 'result' | 'error';
    result?: any;
    error?: string;
}

class WorkerPagefind {
    private backend: any;
    private decoder: TextDecoder;
    private wasm: any;
    private raw_ptr: number | null = null;
    private loaded_chunks: Record<string, boolean> = {};
    private loaded_filters: Record<string, boolean> = {};
    
    constructor() {
        this.backend = wasm_bindgen;
        this.decoder = new TextDecoder("utf-8");
        this.wasm = null;
    }
    
    async init(metaBytes: Uint8Array) {
        this.raw_ptr = this.backend.init_pagefind(metaBytes);
    }
    
    async loadChunk(chunkBytes: Uint8Array) {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        this.raw_ptr = this.backend.load_index_chunk(this.raw_ptr, chunkBytes);
    }
    
    async loadFilter(filterBytes: Uint8Array) {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        this.raw_ptr = this.backend.load_filter_chunk(this.raw_ptr, filterBytes);
    }
    
    async search(query: string, filter?: string, sort?: string, exact?: boolean): Promise<string> {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        
        const searchResult = this.backend.search(
            this.raw_ptr,
            query,
            filter || "",
            sort || "",
            exact || false
        );
        
        return searchResult;
    }
    
    async requestIndexes(query: string): Promise<string[]> {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        
        const indexesJson = this.backend.request_indexes(this.raw_ptr, query);
        return JSON.parse(indexesJson);
    }
    
    async requestFilterIndexes(filters: string): Promise<string[]> {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        
        const indexesJson = this.backend.request_filter_indexes(this.raw_ptr, filters);
        return JSON.parse(indexesJson);
    }
    
    async filters(): Promise<string> {
        if (!this.raw_ptr) throw new Error("Pagefind not initialized");
        return this.backend.filters(this.raw_ptr);
    }
}

// Global instance
let pagefind: WorkerPagefind | null = null;
const pendingLoads = new Map<string, Promise<void>>();

// Message handler
self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
    const { id, type, payload } = event.data;
    
    try {
        let result: any;
        
        switch (type) {
            case 'init':
                if (!pagefind) {
                    pagefind = new WorkerPagefind();
                }
                await pagefind.init(payload.metaBytes);
                result = { success: true };
                break;
                
            case 'search':
                if (!pagefind) throw new Error("Worker not initialized");
                
                // Load required indexes
                const { query, options } = payload;
                const requiredIndexes = await pagefind.requestIndexes(query);
                
                // Load indexes in parallel
                await Promise.all(
                    requiredIndexes.map(async (index) => {
                        if (!pendingLoads.has(index)) {
                            pendingLoads.set(index, loadIndex(index, payload.basePath));
                        }
                        return pendingLoads.get(index);
                    })
                );
                
                // Load filter indexes if needed
                if (options.filters) {
                    const filterIndexes = await pagefind.requestFilterIndexes(
                        JSON.stringify(options.filters)
                    );
                    
                    await Promise.all(
                        filterIndexes.map(async (index) => {
                            if (!pendingLoads.has(index)) {
                                pendingLoads.set(index, loadFilterIndex(index, payload.basePath));
                            }
                            return pendingLoads.get(index);
                        })
                    );
                }
                
                // Perform search
                const searchResult = await pagefind.search(
                    query,
                    options.filters ? JSON.stringify(options.filters) : undefined,
                    options.sort ? JSON.stringify(options.sort) : undefined,
                    options.exact
                );
                
                result = JSON.parse(searchResult);
                break;
                
            case 'filter':
                if (!pagefind) throw new Error("Worker not initialized");
                result = await pagefind.filters();
                break;
                
            case 'preload':
                if (!pagefind) throw new Error("Worker not initialized");
                const { indexes } = payload;
                
                await Promise.all(
                    indexes.map(async (index: string) => {
                        if (!pendingLoads.has(index)) {
                            pendingLoads.set(index, loadIndex(index, payload.basePath));
                        }
                        return pendingLoads.get(index);
                    })
                );
                
                result = { success: true };
                break;
                
            default:
                throw new Error(`Unknown message type: ${type}`);
        }
        
        const response: WorkerResponse = {
            id,
            type: 'result',
            result
        };
        
        self.postMessage(response);
        
    } catch (error) {
        const response: WorkerResponse = {
            id,
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
        };
        
        self.postMessage(response);
    }
});

async function loadIndex(index: string, basePath: string): Promise<void> {
    if (!pagefind) throw new Error("Worker not initialized");
    
    const response = await fetch(`${basePath}index/${index}`);
    if (!response.ok) {
        throw new Error(`Failed to load index ${index}: ${response.statusText}`);
    }
    
    const bytes = new Uint8Array(await response.arrayBuffer());
    await pagefind.loadChunk(bytes);
}

async function loadFilterIndex(index: string, basePath: string): Promise<void> {
    if (!pagefind) throw new Error("Worker not initialized");
    
    const response = await fetch(`${basePath}filter/${index}`);
    if (!response.ok) {
        throw new Error(`Failed to load filter ${index}: ${response.statusText}`);
    }
    
    const bytes = new Uint8Array(await response.arrayBuffer());
    await pagefind.loadFilter(bytes);
}

// Initialize wasm when worker starts
(async () => {
    try {
        // Load wasm module
        const wasmResponse = await fetch('./pagefind_web_bg.wasm');
        const wasmBytes = await wasmResponse.arrayBuffer();
        
        await wasm_bindgen(wasmBytes);
        
        self.postMessage({ type: 'ready' });
    } catch (error) {
        console.error('Failed to initialize worker:', error);
        self.postMessage({ 
            type: 'error', 
            error: error instanceof Error ? error.message : String(error) 
        });
    }
})();