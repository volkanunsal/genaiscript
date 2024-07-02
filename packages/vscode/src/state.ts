import * as vscode from "vscode"
import {
    ChatCompletionsProgressReport,
    Project,
    Fragment,
    PromptScript,
    parseProject,
    GenerationResult,
    groupBy,
    isCancelError,
    delay,
    CHANGE,
    JSONLineCache,
    logInfo,
    logMeasure,
    parseAnnotations,
    MarkdownTrace,
    CORE_VERSION,
    sha256string,
    dotGenaiscriptPath,
    CLI_JS,
    TOOL_ID,
    TOOL_NAME,
    RetrievalSearchResult,
    GENAI_ANYJS_GLOB,
    fixPromptDefinitions,
    resolveModelConnectionInfo,
    AI_REQUESTS_CACHE,
    errorMessage,
} from "genaiscript-core"
import { ExtensionContext } from "vscode"
import { VSCodeHost } from "./vshost"
import { applyEdits, toRange } from "./edit"
import { Utils } from "vscode-uri"
import { findFiles, listFiles, saveAllTextDocuments, writeFile } from "./fs"
import { startLocalAI } from "./localai"
import { hasOutputOrTraceOpened } from "./markdowndocumentprovider"
import { pickLanguageModel } from "./lmaccess"

export const FRAGMENTS_CHANGE = "fragmentsChange"
export const AI_REQUEST_CHANGE = "aiRequestChange"

export const REQUEST_OUTPUT_FILENAME = "GenAIScript Output.md"
export const REQUEST_TRACE_FILENAME = "GenAIScript Trace.md"
export const SEARCH_OUTPUT_FILENAME = "GenAIScript Search.md"

export interface AIRequestOptions {
    label: string
    template: PromptScript
    fragment: Fragment
    parameters: PromptParameters
    notebook?: boolean
}

export class FragmentsEvent extends Event {
    constructor(readonly fragments?: Fragment[]) {
        super(FRAGMENTS_CHANGE)
    }
}
export interface AIRequestSnapshotKey {
    template: {
        id: string
        title: string
        hash: string
    }
    fragment: Fragment
    version: string
}
export interface AIRequestSnapshot {
    response?: Partial<GenerationResult>
    error?: any
    trace?: string
}

export interface AIRequest {
    creationTime: string
    options: AIRequestOptions
    controller: AbortController
    trace: MarkdownTrace
    runId?: string
    request?: Promise<GenerationResult>
    response?: Partial<GenerationResult>
    computing?: boolean
    error?: any
    progress?: ChatCompletionsProgressReport
    editsApplied?: boolean // null = waiting, false, true
}

export function snapshotAIRequest(r: AIRequest): AIRequestSnapshot {
    const { response, error, creationTime, trace } = r
    const { vars, ...responseWithoutVars } = response || {}
    const snapshot = structuredClone({
        creationTime,
        cacheTime: new Date().toISOString(),
        response: responseWithoutVars,
        error,
        trace: trace.content,
    })
    return snapshot
}

export class ExtensionState extends EventTarget {
    readonly host: VSCodeHost
    private _parseWorkspacePromise: Promise<void>
    private _project: Project = undefined
    private _aiRequest: AIRequest = undefined
    private _diagColl: vscode.DiagnosticCollection
    private _aiRequestCache: JSONLineCache<
        AIRequestSnapshotKey,
        AIRequestSnapshot
    > = undefined
    readonly output: vscode.LogOutputChannel

    lastSearch: RetrievalSearchResult

    constructor(public readonly context: ExtensionContext) {
        super()
        this.output = vscode.window.createOutputChannel(TOOL_NAME, {
            log: true,
        })
        this.host = new VSCodeHost(this)
        this.host.addEventListener(CHANGE, this.dispatchChange.bind(this))
        const { subscriptions } = context
        subscriptions.push(this)

        this._diagColl = vscode.languages.createDiagnosticCollection(TOOL_NAME)
        subscriptions.push(this._diagColl)

        this._aiRequestCache = JSONLineCache.byName<
            AIRequestSnapshotKey,
            AIRequestSnapshot
        >(AI_REQUESTS_CACHE)

        // clear errors when file edited (remove me?)
        vscode.workspace.onDidChangeTextDocument(
            (ev) => {
                this._diagColl.set(ev.document.uri, [])
            },
            undefined,
            subscriptions
        )
    }

    private async saveScripts() {
        const dir = this.host.toUri(dotGenaiscriptPath("."))
        await vscode.workspace.fs.createDirectory(dir)

        // add .gitignore
        await writeFile(
            dir,
            ".gitattributes",
            `# avoid merge issues and ignore files in diffs
*.json -diff merge=ours linguist-generated
*.jsonl -diff merge=ours linguist-generated        
*.js -diff merge=ours linguist-generated
`
        )
        // add .gitignore
        await writeFile(
            dir,
            ".gitignore",
            `# ignore local cli
genaiscript.cjs
cache/
retrieval/
containers/
temp/
`
        )
    }

    get cliJsPath() {
        const res = Utils.joinPath(this.context.extensionUri, CLI_JS).fsPath
        return res
    }

    aiRequestCache() {
        return this._aiRequestCache
    }

    async applyEdits() {
        const req = this.aiRequest
        if (!req) return
        const edits = req.response?.edits
        if (!edits) return

        req.editsApplied = null
        this.dispatchChange()

        const applied = await applyEdits(this, edits, {
            needsConfirmation: true,
        })

        req.editsApplied = applied
        if (req !== this.aiRequest) return
        if (req.editsApplied) saveAllTextDocuments()
        this.dispatchChange()
    }

    async requestAI(options: AIRequestOptions): Promise<void> {
        try {
            const req = await this.startAIRequest(options)
            if (!req) {
                await this.cancelAiRequest()
                if (!options.notebook)
                    vscode.commands.executeCommand(
                        "genaiscript.request.open.trace"
                    )
                return
            }
            const res = await req?.request
            const { edits, text, status } = res || {}

            if (!options.notebook) {
                if (status === "error")
                    vscode.commands.executeCommand(
                        "genaiscript.request.open.trace"
                    )
                else if (!hasOutputOrTraceOpened() && text)
                    vscode.commands.executeCommand(
                        "genaiscript.request.open.output"
                    )
            }

            const key = await this.snapshotAIRequestKey(req)
            const snapshot = snapshotAIRequest(req)
            await this._aiRequestCache.set(key, snapshot)
            this.setDiagnostics()
            this.dispatchChange()

            if (edits?.length && !options.notebook) this.applyEdits()
        } catch (e) {
            if (isCancelError(e)) return
            throw e
        }
    }

    private async snapshotAIRequestKey(
        r: AIRequest
    ): Promise<AIRequestSnapshotKey> {
        const { options } = r
        const key = {
            template: {
                id: options.template.id,
                title: options.template.title,
                hash: await sha256string(
                    JSON.stringify({
                        template: options.template,
                    })
                ),
            },
            fragment: options.fragment,
            version: CORE_VERSION,
        }
        return key
    }

    private async startAIRequest(
        options: AIRequestOptions
    ): Promise<AIRequest> {
        const controller = new AbortController()
        const config = vscode.workspace.getConfiguration(TOOL_ID)
        const cache = config.get("cache")
        const signal = controller.signal
        const trace = new MarkdownTrace()

        const r: AIRequest = {
            creationTime: new Date().toISOString(),
            options,
            controller,
            request: null,
            computing: true,
            editsApplied: undefined,
            trace,
        }
        const reqChange = () => {
            if (this._aiRequest === r) {
                this.dispatchEvent(new Event(AI_REQUEST_CHANGE))
                this.setDiagnostics()
                this.dispatchChange()
            }
        }
        const partialCb = (progress: ChatCompletionsProgressReport) => {
            r.progress = progress
            if (r.response) {
                r.response.text = progress.responseSoFar
                if (/\n/.test(progress.responseChunk))
                    r.response.annotations = parseAnnotations(r.response.text)
            }
            reqChange()
        }
        this.aiRequest = r
        trace.addEventListener(CHANGE, reqChange)
        reqChange()

        const { template, fragment, label } = options
        const { files } = fragment || {}
        const { info, configuration: connectionToken } =
            await resolveModelConnectionInfo(template, { token: true })
        if (info.error) {
            trace.error(info.error)
            trace.renderErrors()
            return undefined
        }
        const infoCb = (partialResponse: { text: string }) => {
            r.response = partialResponse
            reqChange()
        }
        /*
        const genOptions: GenerationOptions = {
            requestOptions: { signal },
            cancellationToken,
            partialCb,
            trace,
            infoCb: (data) => {
                r.response = data
                reqChange()
            },
            maxCachedTemperature,
            maxCachedTopP,
            vars: options.parameters,
            cache: cache && template.cache,
            stats: { toolCalls: 0, repairs: 0, turns: 0 },
            cliInfo:
                fragment && !options.notebook
                    ? {
                          spec:
                              this.host.isVirtualFile(fragment.file.filename) &&
                              this.host.path.basename(
                                  fragment.file.filename
                              ) === "dir.gpspec.md"
                                  ? fragment.file.filename.replace(
                                        /dir\.gpspec\.md$/i,
                                        "**"
                                    )
                                  : this.host.isVirtualFile(
                                          fragment.file.filename
                                      )
                                    ? fragment.file.filename.replace(
                                          /\.gpspec\.md$/i,
                                          ""
                                      )
                                    : fragment.file.filename,
                      }
                    : undefined,
            model: info.model,
        }     
            */
        if (!connectionToken) {
            // we don't have a token so ask user if they want to use copilot
            const lmmodel = await pickLanguageModel(this, info.model)
            if (!lmmodel) {
                trace.error("no model provider selected")
                return undefined
            }
            /*
            await configureLanguageModelAccess(
                this.context,
                options,
                genOptions,
                lmmodel
            )
                */
        }
        if (connectionToken?.type === "localai") await startLocalAI()

        const { runId, request } = await this.host.server.client.startScript(
            template.id,
            files,
            {
                signal,
                trace,
                infoCb,
                partialCb,
                label,
                cache: cache && template.cache,
            }
        )
        r.runId = runId
        r.request = request
        if (!options.notebook && !hasOutputOrTraceOpened())
            vscode.commands.executeCommand("genaiscript.request.open.output")
        r.request
            .then((resp) => {
                r.response = resp
                r.computing = false
                if (resp.error) r.error = resp.error
            })
            .catch((e) => {
                r.computing = false
                r.error = e
            })
            .then(reqChange)
        return r
    }

    get parsing() {
        return !!this._parseWorkspacePromise
    }

    get aiRequest() {
        return this._aiRequest
    }

    get diagnostics() {
        const diagnostics = !!vscode.workspace
            .getConfiguration(TOOL_ID)
            .get("diagnostics")
        return diagnostics
    }

    private set aiRequest(r: AIRequest) {
        if (this._aiRequest !== r) {
            this._aiRequest = r
            this.dispatchEvent(new Event(AI_REQUEST_CHANGE))
            this.dispatchChange()
        }
    }

    async cancelAiRequest() {
        const a = this.aiRequest
        if (a && a.computing) {
            a.computing = false
            if (a.controller && !a.controller?.signal?.aborted)
                a.controller.abort?.("user cancelled")
            this.host.server.client.cancel()
            this.dispatchChange()
            await delay(100)
        }
    }

    get project() {
        return this._project
    }

    private async setProject(prj: Project) {
        this._project = prj
        await this.fixPromptDefinitions()
        this.dispatchFragments()
    }

    private dispatchChange() {
        this.dispatchEvent(new Event(CHANGE))
    }

    private dispatchFragments(fragments?: Fragment[]) {
        this.dispatchEvent(new FragmentsEvent(fragments))
        this.dispatchChange()
    }

    async activate() {
        await this.host.activate()
        await this.saveScripts()
        await this.parseWorkspace()
        await this.fixPromptDefinitions()

        logInfo("genaiscript extension activated")
    }

    async fixPromptDefinitions() {
        const project = this.project
        if (project) await fixPromptDefinitions(project)
    }

    async findScripts() {
        const scriptFiles = await findFiles(GENAI_ANYJS_GLOB)
        return scriptFiles
    }

    async parseWorkspace() {
        if (this._parseWorkspacePromise) return this._parseWorkspacePromise

        const parser = async () => {
            try {
                this.dispatchChange()
                performance.mark(`save-docs`)
                await saveAllTextDocuments()
                performance.mark(`project-start`)
                performance.mark(`scan-tools`)
                const scriptFiles = await this.findScripts()
                performance.mark(`parse-project`)
                const newProject = await parseProject({
                    scriptFiles,
                })
                await this.setProject(newProject)
                this.setDiagnostics()
                logMeasure(`project`, `project-start`, `project-end`)
            } finally {
                this._parseWorkspacePromise = undefined
                this.dispatchChange()
            }
        }

        this._parseWorkspacePromise = parser()
        this.dispatchChange()
        await this._parseWorkspacePromise
    }

    async parseDirectory(
        uri: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<Fragment> {
        const fspath = uri.fsPath
        const files = await listFiles(uri)

        return <Fragment>{
            files: files.map((fs) => fs.fsPath),
        }
    }

    async parseDocument(
        document: vscode.Uri,
        token?: vscode.CancellationToken
    ): Promise<Fragment> {
        const fspath = document.fsPath
        return <Fragment>{
            files: [fspath],
        }
    }

    private setDiagnostics() {
        this._diagColl.clear()
        if (this._aiRequest?.options?.notebook) return

        let diagnostics = this.project.diagnostics
        if (this._aiRequest?.response?.annotations?.length)
            diagnostics = diagnostics.concat(
                this._aiRequest?.response?.annotations
            )
        // project entries
        const severities: Record<
            DiagnosticSeverity | "notice",
            vscode.DiagnosticSeverity
        > = {
            notice: vscode.DiagnosticSeverity.Information,
            warning: vscode.DiagnosticSeverity.Warning,
            error: vscode.DiagnosticSeverity.Error,
            info: vscode.DiagnosticSeverity.Information,
        }
        for (const [filename, diags] of Object.entries(
            groupBy(diagnostics, (d) => d.filename)
        )) {
            const ds = diags.map((d) => {
                let message = d.message
                let value: string
                let target: vscode.Uri
                const murl = /\[([^\]]+)\]\((https:\/\/([^)]+))\)/.exec(message)
                if (murl) {
                    value = murl[1]
                    target = vscode.Uri.parse(murl[2], true)
                }
                const r = new vscode.Diagnostic(
                    toRange(d.range),
                    message || "...",
                    severities[d.severity]
                )
                r.source = TOOL_NAME
                r.code = target
                    ? {
                          value,
                          target,
                      }
                    : undefined
                return r
            })
            const uri = Utils.resolvePath(this.host.projectUri, filename)
            this._diagColl.set(uri, ds)
        }
    }

    private clear() {
        this.dispatchChange()
    }

    dispose() {
        this.clear()
    }
}
