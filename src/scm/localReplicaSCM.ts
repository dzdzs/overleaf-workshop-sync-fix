import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';

const IGNORE_SETTING_KEY = 'ignore-patterns';

type FileCache = {date:number, hash:number};

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private saveListener?: vscode.Disposable;
    private localSnapshot: Map<string, {uri:vscode.Uri, signature:string}> = new Map();
    private localPollTimer?: NodeJS.Timeout;
    private localPollDisposable?: vscode.Disposable;
    private localPollRunning = false;
    private initialReconcileTimer?: NodeJS.Timeout;
    private initialReconcileDisposable?: vscode.Disposable;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    private static async findReplicaBaseUri(): Promise<vscode.Uri | undefined> {
        const candidates: vscode.Uri[] = [];
        const seen = new Set<string>();
        const addCandidateAndParents = (uri: vscode.Uri | undefined, uriIsFile: boolean) => {
            if (!uri || uri.scheme!=='file') { return; }
            let current = uriIsFile ? vscode.Uri.file(require('path').dirname(uri.fsPath)) : uri;
            while (current.path && current.path!=='/') {
                if (!seen.has(current.toString())) {
                    seen.add(current.toString());
                    candidates.push(current);
                }
                const parent = vscode.Uri.file(require('path').dirname(current.fsPath));
                if (parent.path===current.path) { break; }
                current = parent;
            }
        };

        addCandidateAndParents(vscode.window.activeTextEditor?.document.uri, true);
        for (const editor of vscode.window.visibleTextEditors || []) {
            addCandidateAndParents(editor.document.uri, true);
        }
        for (const folder of vscode.workspace.workspaceFolders || []) {
            addCandidateAndParents(folder.uri, false);
        }

        for (const candidate of candidates) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.joinPath(candidate, '.overleaf/settings.json'));
                return candidate;
            } catch {}
        }

        // Support a project nested inside a larger remote workspace.
        try {
            const settingsFiles = await vscode.workspace.findFiles('**/.overleaf/settings.json', '**/node_modules/**', 20);
            if (settingsFiles.length===1) {
                return vscode.Uri.file(require('path').dirname(require('path').dirname(settingsFiles[0].fsPath)));
            }
        } catch {}
        return undefined;
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const baseUri = await this.findReplicaBaseUri();
        return baseUri ? vscode.Uri.joinPath(baseUri, path) : undefined;
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const baseUri = await this.findReplicaBaseUri();
        return baseUri ? uri.path.slice(baseUri.path.length) : undefined;
    }

    public static async readSettings(expectedOrigin?: vscode.Uri): Promise<any | undefined> {
        const readAt = async (settingUri: vscode.Uri) => {
            try {
                const content = await vscode.workspace.fs.readFile(settingUri);
                const settings = JSON.parse( new TextDecoder().decode(content) );
                settings._localReplicaBaseUri = vscode.Uri.file(require('path').dirname(require('path').dirname(settingUri.fsPath))).toString();
                return settings;
            } catch {
                return undefined;
            }
        };
        const matchesOrigin = (settings: any) => {
            if (!expectedOrigin) { return true; }
            try {
                return vscode.Uri.parse(settings?.uri || '').toString()===expectedOrigin.toString();
            } catch {
                return false;
            }
        };

        const baseUri = await this.findReplicaBaseUri();
        if (baseUri) {
            const settings = await readAt(vscode.Uri.joinPath(baseUri, '.overleaf/settings.json'));
            if (settings && matchesOrigin(settings)) { return settings; }
        }

        // Parent workspaces can contain several local Overleaf replicas.
        try {
            const settingUris = await vscode.workspace.findFiles('**/.overleaf/settings.json', '**/node_modules/**', 200);
            for (const settingUri of settingUris) {
                const settings = await readAt(settingUri);
                if (settings && matchesOrigin(settings)) { return settings; }
            }
        } catch {}
        return undefined;
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: 'push'|'pull') {
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action==='pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            // console.log(action, relPath, `[${cache[0].hash}, ${cache[1].hash}]`, thisHash);
            if (action==='push' && cache[0].hash===thisHash) { return false; }
            if (action==='pull' && cache[1].hash===thisHash) { return false; }
            if (cache[0].hash!==cache[1].hash) {
                if (action==='push' && now-cache[0].date<500 || action==='pull' && now-cache[1].date<500) {
                    this.setBypassCache(relPath, content, action);
                    return true;
                }
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    private async overwrite(root: string='/'): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            // breadth-first search for the files
            const files: [string,string][] = [];
            const queue: string[] = [root];
            while (queue.length!==0) {
                const nextRoot = queue.shift();
                const vfsUri = this.vfs.pathToUri(nextRoot!);
                const items = await vscode.workspace.fs.readDirectory(vfsUri);
                if (token.isCancellationRequested) { return undefined; }
                //
                for (const [name, type] of items) {
                    const relPath = nextRoot + name;
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        queue.push(relPath+'/');
                    } else {
                        files.push([name, relPath]);
                    }
                }
            }

            // sync the files
            const total = files.length;
            for (let i=0; i<total; i++) {
                const [name, relPath] = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: 100/total, message: relPath});
                //
                const baseContent = this.baseCache[relPath];
                const localContent = await this.readFile(relPath);
                const remoteContent = await vscode.workspace.fs.readFile(vfsUri);
                if (localContent===undefined) {
                    // Remote-only file: populate the local replica.
                    this.setBypassCache(relPath, remoteContent);
                    await this.writeFile(relPath, remoteContent);
                    this.baseCache[relPath] = remoteContent;
                } else if (baseContent===undefined) {
                    // Existing local replica: keep its saved content when associating it.
                    this.setBypassCache(relPath, localContent);
                    if (hashCode(localContent)!==hashCode(remoteContent)) {
                        await vscode.workspace.fs.writeFile(vfsUri, localContent);
                    }
                    this.baseCache[relPath] = localContent;
                } else {
                    const dmp = new DiffMatchPatch();
                    const baseContentStr = new TextDecoder().decode(baseContent);
                    const localContentStr = new TextDecoder().decode(localContent);
                    const remoteContentStr = new TextDecoder().decode(remoteContent);
                    // merge local and remote changes
                    const localPatches = dmp.patch_make( baseContentStr, localContentStr );
                    const remotePatches = dmp.patch_make( baseContentStr, remoteContentStr );
                    const [mergedContentStr, _results] = dmp.patch_apply( remotePatches, localContentStr );
                    // write the merged content to local
                    const mergedContent = new TextEncoder().encode(mergedContentStr);
                    await this.writeFile(relPath, mergedContent);
                    // write the merged content to remote
                    if (localPatches.length!==0) {
                        await vscode.workspace.fs.writeFile(vfsUri, mergedContent);
                    }
                }
            }

            return true;
        });
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        await (async () => {
            if (type==='delete') {
                const newContent = undefined;
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                delete this.baseCache[relPath];
                await vscode.workspace.fs.delete(toUri, {recursive:true});
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type===vscode.FileType.File) {
                    try {
                        const newContent = await vscode.workspace.fs.readFile(fromUri);
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        // A remote document must be joined before writeFile can build
                        // a versioned OT update. Initialize only the changed document.
                        if (action==='push') {
                            if (await this.vfs.createFileFromLocalReplica(toUri, newContent)) {
                                this.baseCache[relPath] = newContent;
                                return;
                            }
                            try {
                                await vscode.workspace.fs.readFile(toUri);
                            } catch (error) {
                                const fsError = error as vscode.FileSystemError;
                                const isMissing = fsError?.code==='FileNotFound' || fsError?.name?.startsWith('EntryNotFound');
                                if (!isMissing) { throw error; }
                                // New local files do not exist remotely yet. writeFile
                                // below will create them in the Overleaf project.
                            }
                        }
                        await vscode.workspace.fs.writeFile(toUri, newContent);
                        this.baseCache[relPath] = newContent;
                        if (action==='push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
                    } catch (error) {
                        console.error(error);
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        })();

        this.status = {status: 'idle', message: ''};
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = ('/' + pathParts.join('/'));
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        return await this.applySync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        return await this.applySync('push', type, relPath, localUri, vfsUri);
    }

    /**
     * Push a saved document to the VFS.
     * Only fires for explicit user saves in the editor, not for external
     * file modifications (git, compilation tools, etc.).
     * This is the general fix for issues #299 and #323.
     */
    private onDocumentSaved(doc: vscode.TextDocument) {
        const docUri = doc.uri;
        // Only sync files within our baseUri (ensure path separator boundary)
        const basePath = this.baseUri.path.endsWith('/') ? this.baseUri.path : this.baseUri.path + '/';
        if (!docUri.path.startsWith(basePath)) { return; }
        this.syncToVFS(docUri, 'update');
    }

    private async scanLocalFiles(): Promise<Map<string, {uri:vscode.Uri, signature:string}>> {
        const files = new Map<string, {uri:vscode.Uri, signature:string}>();
        const queue = [''];
        while (queue.length) {
            const dir = queue.shift()!;
            const dirUri = vscode.Uri.file(require('path').join(this.baseUri.fsPath, dir));
            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(dirUri);
            } catch {
                continue;
            }
            for (const [name, type] of entries) {
                const relPath = dir ? `${dir}/${name}` : name;
                if (this.matchIgnorePatterns(relPath)) { continue; }
                const uri = vscode.Uri.file(require('path').join(this.baseUri.fsPath, relPath));
                if (type===vscode.FileType.Directory) {
                    queue.push(relPath);
                } else if (type===vscode.FileType.File) {
                    try {
                        const stat = await vscode.workspace.fs.stat(uri);
                        files.set(relPath, {uri, signature:`${stat.mtime}:${stat.size}`});
                    } catch {}
                }
            }
        }
        return files;
    }

    private async pollLocalChanges() {
        if (this.localPollRunning) { return; }
        this.localPollRunning = true;
        try {
            const current = await this.scanLocalFiles();
            const previous = this.localSnapshot;
            this.localSnapshot = current;
            for (const [relPath, entry] of current) {
                if (previous.get(relPath)?.signature!==entry.signature) {
                    console.log(`Overleaf Workshop: detected local change "${relPath}"`);
                    await this.syncToVFS(entry.uri, 'update');
                }
            }
            for (const [relPath, entry] of previous) {
                if (!current.has(relPath)) {
                    await this.syncToVFS(entry.uri, 'delete');
                }
            }
        } catch (error) {
            console.error('Overleaf Workshop: local polling failed', error);
        } finally {
            this.localPollRunning = false;
        }
    }

    private async reconcileLocalFiles() {
        try {
            const files = await this.scanLocalFiles();
            for (const entry of files.values()) {
                await this.syncToVFS(entry.uri, 'update');
            }
        } catch (error) {
            console.error('Overleaf Workshop: initial local reconciliation failed', error);
        }
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error) {
            await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ));
        }

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri, '**/*' )
        );

        // Avoid blocking replica creation on a full remote replay. Large projects
        // can exceed the collaboration API timeout during that operation.

        // Listen for explicit user saves (not file system changes) to push local edits.
        // File system watchers would also fire for git operations, compilation outputs,
        // and other external modifications, causing unwanted sync (issues #299, #323).
        this.saveListener = vscode.workspace.onDidSaveTextDocument(
            doc => this.onDocumentSaved(doc)
        );
        this.localSnapshot = await this.scanLocalFiles();
        console.log(`Overleaf Workshop: local polling started for "${this.baseUri.fsPath}" (${this.localSnapshot.size} files)`);
        this.localPollTimer = setInterval(() => this.pollLocalChanges(), 1500);
        this.localPollDisposable = new vscode.Disposable(() => {
            if (this.localPollTimer) { clearInterval(this.localPollTimer); }
        });
        // Upload edits made while disconnected without delaying VFS connection.
        this.initialReconcileTimer = setTimeout(() => this.reconcileLocalFiles(), 0);
        this.initialReconcileDisposable = new vscode.Disposable(() => {
            if (this.initialReconcileTimer) { clearTimeout(this.initialReconcileTimer); }
        });

        return [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(async uri => await this.syncFromVFS(uri, 'delete')),
            // sync local changes from editors, terminals, and coding agents
            this.localWatcher.onDidChange(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidCreate(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidDelete(async uri => await this.syncToVFS(uri, 'delete')),
            // include listeners for proper disposal
            this.saveListener,
            this.localPollDisposable,
            this.initialReconcileDisposable,
        ];
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
