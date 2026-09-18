/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { SocketIOAlt } from './socketioAlt';
import * as DiffMatchPatch from 'diff-match-patch';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

type ConnectionScheme = 'Alt' | 'v1' | 'v2';

export class SocketIOAPI {
    private scheme: ConnectionScheme = 'v1';
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];
    /** Track EventBus listeners for cleanup to prevent MaxListenersExceededWarning */
    private _eventBusCleanups: Array<()=>void> = [];

    private socket?: any;
    private emit: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;
    /** Monotonically identifies the socket used by an in-flight request. */
    private socketGeneration = 0;
    /** Share one recovery between all requests that time out on the same socket. */
    private documentRecovery?: Promise<void>;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        // Clean up old EventBus listeners before creating new socket
        this._cleanupEventBusListeners();

        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        if (this.socket) {
            try {
                // Remove all listeners to prevent stale event handlers from firing
                if (typeof this.socket.removeAllListeners === 'function') {
                    this.socket.removeAllListeners();
                }
                // Gracefully close the connection (sends FIN, not RST)
                if (typeof this.socket.disconnect === 'function') {
                    this.socket.disconnect();
                }
            } catch {
                // Best-effort cleanup; socket may already be in a bad state
            }
        }

        // connect
        switch(this.scheme) {
            case 'Alt':
                this.socket = new SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        this.socketGeneration += 1;
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject('timeout');
                }, 5000);
            });
            const waitPromise = new Promise((resolve, reject) => {
                this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket;
    }

    /** Clean up any accumulated EventBus listeners */
    private _cleanupEventBusListeners() {
        for (const cleanup of this._eventBusCleanups) {
            try { cleanup(); } catch {}
        }
        this._eventBusCleanups = [];
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            console.log('SocketIOAPI: connected');
        });
        this.socket.on('connect_failed', () => {
            console.log('SocketIOAPI: connect_failed');
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
        });
        this.socket.on('connectionRejected', (err:any) => {
            console.log('SocketIOAPI: connectionRejected.', err?.message || err);
            // If v2 also gets rejected, fall back to v1 rather than staying stuck
            if (this.scheme === 'v2') {
                console.log('SocketIOAPI: v2 rejected, falling back to v1');
                this.scheme = 'v1';
            }
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            if (this.socket.io && typeof this.socket.io.reconnect === 'function') {
                this.socket.io.reconnect(false);
            }
        });
        this.socket.on('error', (err:any) => {
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
        });

        if (this.scheme==='v2') {
            this.record = new Promise(resolve => {
                this.socket.on('joinProjectResponse', (res:any) => {
                    const publicId = res.publicId as string;
                    const project = res.project as ProjectEntity;
                    EventBus.fire('socketioConnectedEvent', {publicId});
                    resolve(project);
                });
            });
        }
    }

    disconnect() {
        this.socket.disconnect();
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    // Track EventBus listener via Disposable for cleanup to prevent MaxListenersExceededWarning
                    const eventBusDisposable = EventBus.on('socketioConnectedEvent', (arg:{publicId:string}) => {
                        handler(arg.publicId);
                    });
                    this._eventBusCleanups.push(() => eventBusDisposable.dispose());
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        if (this.socket instanceof SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this.socket instanceof SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            setTimeout(() => {
                reject('timeout');
            }, 5000);
        });

        switch(this.scheme) {
            case 'Alt':
            case 'v1':
                const joinPromise = this.emit('joinProject', {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    this.record = Promise.resolve(project);
                    return project;
                });
                const rejectPromise = new Promise((_, reject) => {
                    this.socket.on('connectionRejected', (err:any) => {
                        // Only fall back to v2 if we haven't already tried it;
                        // otherwise let the outer retry logic handle backoff
                        this.scheme = 'v2';
                        reject(err.message);
                    });
                });
                return Promise.race([joinPromise, rejectPromise, timeoutPromise]).catch(err => {
                    // The current Overleaf service can leave the legacy v1
                    // joinProject request unanswered instead of rejecting it. Switch
                    // to the project-scoped v2 socket immediately on that timeout.
                    if (this.scheme==='v1' && err==='timeout') {
                        console.log('SocketIOAPI: v1 join timed out, switching to v2');
                        return this.api.updateCookies(this.identity).then(() => {
                            this.scheme = 'v2';
                            this.init();
                            return this.joinProject(project_id);
                        });
                    }
                    return Promise.reject(err);
                });
            case 'v2':
                return Promise.race([this.record!, timeoutPromise]);
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    private async joinDocOnce(docId:string) {
        const returns = await this.emit('joinDoc', docId, { encodeRanges: true }) as [Array<string>, number, Array<any>, any];
        const [docLinesAscii, version, updates, ranges] = returns;
        const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
        return {docLines, version, updates, ranges};
    }

    private async recoverDocumentSocket() {
        if (!this.documentRecovery) {
            const recovery = (async () => {
                await this.api.updateCookies(this.identity);
                this.scheme = 'v2';
                this.init();
                await this.joinProject(this.projectId);
            })();
            this.documentRecovery = recovery;
            recovery.finally(() => {
                if (this.documentRecovery===recovery) {
                    this.documentRecovery = undefined;
                }
            }).catch(() => {});
        }
        await this.documentRecovery;
    }

    async joinDoc(docId:string) {
        const requestGeneration = this.socketGeneration;
        try {
            return await this.joinDocOnce(docId);
        } catch (error) {
            if (String(error)!=='timeout') { throw error; }
            // A legacy Socket.IO connection can remain nominally connected while
            // document acknowledgements stop arriving. Refresh its short-lived
            // cookie and replace it with a project-scoped v2 connection. Requests
            // that timed out on an already replaced socket simply retry on the
            // current generation; concurrent timeouts share the same recovery.
            if (requestGeneration===this.socketGeneration) {
                await this.recoverDocumentSocket();
            } else if (this.documentRecovery) {
                await this.documentRecovery;
            }
            return await this.joinDocOnce(docId);
        }
    }

    /**
     * Write one local-replica document through an isolated project-scoped
     * connection. The editor socket is intentionally not reused: Overleaf's
     * secondary Socket.IO cookie and document acknowledgements can expire while
     * the main login remains valid.
     */
    async writeLocalReplicaDocument(docId:string, content:string) {
        const emit = (socket:any, event:string, ...args:any[]) => new Promise<any[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${event} timeout`)), 15000);
            socket.emit(event, ...args, (error:any, ...data:any[]) => {
                clearTimeout(timer);
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else {
                    resolve(data);
                }
            });
        });
        const openIsolatedProjectSocket = async () => {
            await this.api.updateCookies(this.identity);
            const query = `?projectId=${this.projectId}&t=${Date.now()}`;
            const socket = this.api._initSocketV0(this.identity, query);
            socket.on('error', () => {});
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('joinProjectResponse timeout')), 15000);
                socket.on('joinProjectResponse', () => {
                    clearTimeout(timer);
                    resolve();
                });
                socket.on('connectionRejected', (error:any) => {
                    clearTimeout(timer);
                    reject(new Error(error?.message || 'connection rejected'));
                });
            });
            return socket;
        };
        const socket = await openIsolatedProjectSocket();
        let verificationSocket:any;

        try {
            const joined = await emit(socket, 'joinDoc', docId, {encodeRanges:true});
            const remoteContent = (joined[0] as string[]).map(line => decodePackedUtf8(line)).join('\n');
            const version = joined[1] as number;
            if (remoteContent===content) { return; }

            const dmp = new DiffMatchPatch();
            let currentPos = 0;
            const op = dmp.diff_main(remoteContent, content).map(part => {
                // diff-match-patch can emit empty edit components around
                // Unicode boundaries. ShareJS rejects {i:""} and {d:""} as
                // invalid OT arguments.
                if (part[1].length===0) { return undefined; }
                const incCount = part[0]===-1 ? 0 : part[1].length;
                currentPos += incCount;
                if (part[0]===0) { return undefined; }
                return {
                    p: currentPos-incCount,
                    i: part[0]===1 ? part[1] : undefined,
                    d: part[0]===-1 ? part[1] : undefined,
                };
            }).filter(update => update!==undefined);
            const hash = require('crypto').createHash('sha1').update(
                // Overleaf's ShareJS compatibility layer hashes the JavaScript
                // string length used by its text OT model.
                `blob ${content.length}\x00${content}`
            ).digest('hex');
            await emit(socket, 'applyOtUpdate', docId, {doc:docId, v:version, hash, op});

            // Rejoining on the writing socket can return its optimistic local OT
            // state even if the server never persisted the update. Verify through
            // a new project-scoped connection before advancing the replica state.
            verificationSocket = await openIsolatedProjectSocket();
            const verified = await emit(verificationSocket, 'joinDoc', docId, {encodeRanges:true});
            const verifiedContent = (verified[0] as string[])
                .map(line => decodePackedUtf8(line)).join('\n');
            if (verifiedContent!==content) {
                throw new Error('Overleaf rejected or did not commit the document update');
            }
        } finally {
            for (const currentSocket of [socket, verificationSocket]) {
                try {
                    currentSocket?.removeAllListeners();
                    currentSocket?.disconnect();
                } catch {}
            }
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
