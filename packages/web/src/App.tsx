/// <reference path="../../core/src/types/prompt_template.d.ts" />
import React, {
    createContext,
    Dispatch,
    SetStateAction,
    startTransition,
    Suspense,
    use,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from "react"
import {
    VscodeButton,
    VscodeSingleSelect,
    VscodeOption,
    VscodeTextfield,
    VscodeCheckbox,
    VscodeFormContainer,
    VscodeFormGroup,
    VscodeFormHelper,
    VscodeLabel,
    VscodeProgressRing,
    VscodeCollapsible,
    VscodeTabs,
    VscodeTabHeader,
    VscodeTabPanel,
    VscodeBadge,
    VscodeTextarea,
    VscodeMultiSelect,
    VscodeScrollable,
} from "@vscode-elements/react-elements"
import Markdown from "./Markdown"
import type {
    Project,
    PromptScriptListResponse,
    PromptScriptResponseEvents,
    GenerationResult,
    ServerEnvResponse,
    RequestMessages,
    PromptScriptStartResponse,
    PromptScriptEndResponseEvent,
} from "../../core/src/server/messages"
import {
    logprobToMarkdown,
    topLogprobsToMarkdown,
} from "../../core/src/logprob"
import { FileWithPath, useDropzone } from "react-dropzone"
import prettyBytes from "pretty-bytes"
import { renderMessagesToMarkdown } from "../../core/src/chatrender"
import { stringify as YAMLStringify } from "yaml"
import { fenceMD } from "../../core/src/mkmd"
import { isBinaryMimeType } from "../../core/src/binary"
import { toBase64 } from "../../core/src/base64"
import { underscore } from "inflection"
import { lookupMime } from "../../core/src/mime"
import dedent from "dedent"
import { markdownDiff } from "../../core/src/mddiff"
import { VscodeMultiSelect as VscodeMultiSelectElement } from "@vscode-elements/elements"
import { cleanedClone } from "../../core/src/clone"
import { WebSocketClient } from "../../core/src/server/wsclient"
import { convertAnnotationToItem } from "../../core/src/annotations"
import MarkdownWithPreview from "./MarkdownWithPreview"

interface GenAIScriptViewOptions {
    apiKey?: string
    base?: string
}
interface GenAIScriptHost {
    genaiscript?: GenAIScriptViewOptions
}

const urlParams = new URLSearchParams(window.location.search)
const config = (self as GenAIScriptHost).genaiscript
delete (self as GenAIScriptHost).genaiscript
const hosted = !!config
const viewMode = (hosted ? "results" : urlParams.get("view")) as
    | "results"
    | undefined
const hashParams = new URLSearchParams(window.location.hash)
const base = config?.base || ""
const apiKey = hashParams.get("api-key") || config?.apiKey
window.location.hash = ""

if (!hosted) import("@vscode-elements/webview-playground")

const fetchScripts = async (): Promise<Project> => {
    const res = await fetch(`${base}/api/scripts`, {
        headers: {
            Accept: "application/json",
            Authorization: apiKey || "",
        },
    })
    if (!res.ok) throw new Error(await res.json())

    const j: PromptScriptListResponse = await res.json()
    return j.project
}
const fetchEnv = async (): Promise<ServerEnvResponse> => {
    const res = await fetch(`${base}/api/env`, {
        headers: {
            Accept: "application/json",
            Authorization: apiKey || "",
        },
    })
    if (!res.ok) throw new Error(await res.json())

    const j: ServerEnvResponse = await res.json()
    return j
}
const fetchRun = async (
    runId: string
): Promise<PromptScriptEndResponseEvent> => {
    const res = await fetch(`${base}/api/runs/${runId}`, {
        headers: {
            Accept: "application/json",
            Authorization: apiKey || "",
        },
    })
    if (!res.ok) throw new Error(await res.json())

    const j: PromptScriptEndResponseEvent = await res.json()
    return j
}

class RunClient extends WebSocketClient {
    static readonly SCRIPT_START_EVENT = "scriptStart"
    static readonly SCRIPT_END_EVENT = "scriptEnd"
    static readonly PROGRESS_EVENT = "progress"
    static readonly RUN_EVENT = "run"
    static readonly RESULT_EVENT = "result"

    runId: string
    trace: string = ""
    output: string = ""
    result: Partial<GenerationResult> = undefined

    constructor(url: string) {
        super(url)
        this.addEventListener(
            "message",
            async (ev) => {
                const data = (ev as MessageEvent<any>).data as
                    | PromptScriptResponseEvents
                    | RequestMessages
                switch (data.type) {
                    case "script.progress": {
                        this.updateRunId(data)
                        if (data.trace) this.trace += data.trace
                        if (data.output) this.output += data.output
                        this.dispatchEvent(new Event(RunClient.PROGRESS_EVENT))
                        break
                    }
                    case "script.end": {
                        this.updateRunId(data)
                        if (data.result) {
                            this.result = cleanedClone(data.result)
                        } else {
                            const e = await fetchRun(data.runId)
                            this.result = cleanedClone(e.result)
                            this.trace = e.trace || ""
                        }
                        this.output = this.result?.text || ""
                        this.dispatchEvent(
                            new CustomEvent(RunClient.SCRIPT_END_EVENT, {
                                detail: this.result,
                            })
                        )
                        this.dispatchEvent(new Event(RunClient.RESULT_EVENT))
                        this.dispatchEvent(new Event(RunClient.PROGRESS_EVENT))
                        break
                    }
                    case "script.start":
                        this.updateRunId(
                            data.response as PromptScriptStartResponse
                        )
                        this.dispatchEvent(
                            new CustomEvent(RunClient.SCRIPT_START_EVENT, {
                                detail: data.response,
                            })
                        )
                        break
                    default: {
                        console.log(data)
                    }
                }
            },
            false
        )
    }

    private updateRunId(data: { runId: string }) {
        const { runId } = data
        if (runId !== this.runId) {
            this.runId = runId
            if (this.runId) {
                this.trace = ""
                this.output = ""
                this.result = undefined
                this.dispatchEvent(new Event(RunClient.RESULT_EVENT))
            }
            this.dispatchEvent(new Event(RunClient.RUN_EVENT))
        }
    }
}

function useUrlSearchParams<T>(
    initialValues: T,
    fields: Record<
        string,
        | JSONSchemaString
        | JSONSchemaNumber
        | JSONSchemaBoolean
        | JSONSchemaArray
    >
) {
    const [state, setState] = useState<T>(initialValues)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const newState: any = {}
        Object.entries(fields).forEach(([key, field]) => {
            const { type } = field
            const value = params.get(key)
            if (value !== undefined && value !== null) {
                if (type === "string") {
                    if (value !== "") newState[key] = value
                } else if (type === "boolean")
                    newState[key] =
                        value === "1" || value === "yes" || value === "true"
                else if (type === "integer" || type === "number") {
                    const parsed =
                        type === "number" ? parseFloat(value) : parseInt(value)
                    if (!isNaN(parsed)) newState[key] = parsed
                } else if (type === "array") {
                    const parsed = value.split(",").filter((s) => s !== "")
                    if (parsed.length > 0) newState[key] = parsed
                }
            }
        })
        setState(newState)
    }, [])
    useEffect(() => {
        const params = new URLSearchParams(urlParams)
        for (const key in state) {
            const field = fields[key]
            if (!field) continue

            const { type } = field
            const value = state[key]
            if (value === undefined || value === null) continue
            if (type === "string") {
                if (value !== "") params.set(key, value as string)
            } else if (type === "boolean") {
                if (!!value) params.set(key, "1")
            } else if (type === "integer" || type === "number") {
                const v = value as number
                if (!isNaN(v)) params.set(key, v.toString())
            } else if (type === "array") {
                const v = (value as string[]).filter((s) => s !== "")
                if (v.length) params.set(key, v.join(","))
            }
        }

        let url = ""
        if (params.toString()) url += `?${params.toString()}`
        window.history.pushState({}, "", url)
    }, [state])
    return [state, setState] as const
}

type ImportedFile = FileWithPath & { selected?: boolean }

const ApiContext = createContext<{
    client: RunClient
    project: Promise<Project | undefined>
    env: Promise<ServerEnvResponse | undefined>

    scriptid: string | undefined
    setScriptid: (id: string) => void
    files: string[]
    setFiles: (files: string[]) => void
    importedFiles: ImportedFile[]
    setImportedFiles: (files: ImportedFile[]) => void
    parameters: PromptParameters
    setParameters: (parameters: PromptParameters) => void
    options: ModelOptions
    setOptions: (
        f: (prev: ModelConnectionOptions) => ModelConnectionOptions
    ) => void
} | null>(null)

function ApiProvider({ children }: { children: React.ReactNode }) {
    const client = useMemo(() => {
        const client = new RunClient(
            `${base}/${apiKey ? `?api-key=${apiKey}` : ""}`
        )
        client.addEventListener("error", (err) => console.error(err), false)
        return client
    }, [])

    const project = useMemo<Promise<Project>>(fetchScripts, [])
    const env = useMemo<Promise<ServerEnvResponse>>(fetchEnv, [])

    const [state, setState] = useUrlSearchParams<
        {
            scriptid: string
            files: string[]
        } & ModelConnectionOptions
    >(
        {
            scriptid: "",
            files: [],
        },
        {
            scriptid: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            cache: { type: "boolean" },
            provider: { type: "string" },
            model: { type: "string" },
            smallModel: { type: "string" },
            visionModel: { type: "string" },
            temperature: { type: "number" },
            logprobs: { type: "boolean" },
            topLogprobs: { type: "integer" },
        }
    )
    const [importedFiles, setImportedFiles] = useState<ImportedFile[]>([])
    const { scriptid, files, ...options } = state
    const [parameters, setParameters] = useState<PromptParameters>({})
    const setScriptid = (id: string) =>
        setState((prev) => ({ ...prev, scriptid: id }))
    const setFiles = (files: string[]) =>
        setState((prev) => ({
            ...prev,
            files: files.filter((s) => s !== "").slice(),
        }))
    const setOptions = (
        f: (prev: ModelConnectionOptions) => ModelConnectionOptions
    ) => {
        setState((prev) => ({ ...prev, ...f(options) }))
    }
    useEffect(() => {
        client.init()
    }, [])

    return (
        <ApiContext.Provider
            value={{
                client,
                project,
                env,
                scriptid,
                setScriptid,
                files,
                setFiles,
                importedFiles,
                setImportedFiles,
                parameters,
                setParameters,
                options,
                setOptions,
            }}
        >
            {children}
        </ApiContext.Provider>
    )
}

function useApi() {
    const api = use(ApiContext)
    if (!api) throw new Error("missing content")
    return api
}

function useEnv() {
    const { env: envPromise } = useApi()
    const env = use(envPromise)
    return env
}

const RunnerContext = createContext<{
    runId: string | undefined
    run: () => void
    cancel: () => void
    state: "running" | undefined
} | null>(null)

function RunnerProvider({ children }: { children: React.ReactNode }) {
    const {
        client,
        scriptid,
        files = [],
        importedFiles = [],
        options,
        parameters,
    } = useApi()

    const [runId, setRunId] = useState<string>(client.runId)

    useEffect(() => {
        client.abortScript(runId)
        setRunId(undefined)
    }, [scriptid])

    const start = useCallback((e: Event) => {
        const ev = e as CustomEvent
        setRunId(ev.detail.runId)
    }, [])
    useEventListener(client, RunClient.SCRIPT_START_EVENT, start, false)

    const runUpdate = useCallback((e: Event) => setRunId(client.runId), [runId])
    useEventListener(client, RunClient.RUN_EVENT, runUpdate, false)

    const end = useCallback((e: Event) => {
        const ev = e as CustomEvent
        setRunId(undefined)
    }, [])
    useEventListener(client, RunClient.SCRIPT_END_EVENT, end, false)

    const run = async () => {
        if (!scriptid) return

        const runId = ("" + Math.random()).slice(2)
        const workspaceFiles = await Promise.all(
            importedFiles
                .filter(({ selected }) => selected)
                .map(async (f) => {
                    const binary = isBinaryMimeType(f.type)
                    const buffer = binary
                        ? new Uint8Array(await f.arrayBuffer())
                        : undefined
                    const content = buffer ? toBase64(buffer) : await f.text()
                    return {
                        filename: f.path || f.relativePath,
                        type: f.type,
                        encoding: binary ? "base64" : undefined,
                        content,
                    } satisfies WorkspaceFile
                })
        )
        client.startScript(runId, scriptid, files, {
            ...(options || {}),
            vars: parameters,
            workspaceFiles,
        })
    }

    const cancel = () => {
        client.abortScript(runId)
        setRunId(undefined)
    }

    const state = runId ? "running" : undefined

    return (
        <RunnerContext.Provider
            value={{
                runId,
                run,
                cancel,
                state,
            }}
        >
            {children}
        </RunnerContext.Provider>
    )
}

function useRunner() {
    const runner = use(RunnerContext)
    if (!runner) throw new Error("runner context not configured")
    return runner
}

function useResult(): Partial<GenerationResult> | undefined {
    const { client } = useApi()
    const [result, setResult] = useState(client.result)
    const update = useCallback(() => setResult(client.result), [client])
    useEventListener(client, RunClient.RESULT_EVENT, update)
    return result
}

function useScripts() {
    const api = useApi()
    const project = use(api.project)
    const scripts = (project?.scripts?.filter((s) => !s.isSystem) || []).sort(
        (l, r) => l.id.localeCompare(r.id)
    )
    return scripts
}

function useScript() {
    const scripts = useScripts()
    const { scriptid } = useApi()
    return scripts.find((s) => s.id === scriptid)
}

function useEventListener(
    target: EventTarget | undefined,
    eventName: string,
    handler: EventListener,
    options?: boolean | AddEventListenerOptions
) {
    useEffect(() => {
        target?.addEventListener(eventName, handler, options)
        return () => target?.removeEventListener(eventName, handler, options)
    }, [target, eventName, handler, JSON.stringify(options)])
}

function useTrace() {
    const { client } = useApi()
    const [trace, setTrace] = useState(client.trace)
    const appendTrace = useCallback(
        (evt: Event) =>
            startTransition(() => setTrace((previous) => client.trace)),
        []
    )
    useEventListener(client, RunClient.PROGRESS_EVENT, appendTrace)
    return trace
}

function useOutput() {
    const { client } = useApi()
    const [output, setOutput] = useState<string>(client.output)
    const appendTrace = useCallback(
        (evt: Event) =>
            startTransition(() => setOutput((previous) => client.output)),
        []
    )
    useEventListener(client, RunClient.PROGRESS_EVENT, appendTrace)
    return output
}

function GenAIScriptLogo(props: { height: string }) {
    const { height } = props
    return (
        <img
            alt="GenAIScript logo"
            src="/favicon.svg"
            style={{ height, borderRadius: "2px" }}
        />
    )
}

function JSONSchemaNumber(props: {
    schema: JSONSchemaNumber
    value: number
    onChange: (value: number) => void
}) {
    const { schema, value, onChange } = props
    const { type, minimum, maximum } = schema
    const required = schema.default === undefined
    const [valueText, setValueText] = useState(
        isNaN(value) ? "" : String(value)
    )

    useEffect(() => {
        const v =
            type === "number" ? parseFloat(valueText) : parseInt(valueText)
        if (!isNaN(v) && v !== value) onChange(v)
    }, [valueText])

    return (
        <VscodeTextfield
            value={valueText}
            required={required}
            placeholder={schema.default + ""}
            min={minimum}
            max={maximum}
            inputMode={type === "number" ? "decimal" : "numeric"}
            onChange={(e) => {
                const target = e.target as HTMLInputElement
                startTransition(() => setValueText(target.value))
            }}
        />
    )
}

function JSONSchemaSimpleTypeFormField(props: {
    field: JSONSchemaSimpleType
    value: string | boolean | number | object
    required?: boolean
    onChange: (value: string | boolean | number | object) => void
}) {
    const { field, required, value, onChange } = props

    const rows = (s: string | undefined) =>
        Math.max(3, s.split("\n").length ?? 0)

    switch (field.type) {
        case "number":
        case "integer":
            return (
                <JSONSchemaNumber
                    schema={field}
                    value={Number(value)}
                    onChange={onChange}
                />
            )
        case "string": {
            const vs = (value as string) || ""
            if (field.enum) {
                return (
                    <VscodeSingleSelect
                        value={vs}
                        required={required}
                        onChange={(e) => {
                            const target = e.target as HTMLSelectElement
                            onChange(target.value)
                        }}
                    >
                        {field.enum.map((option) => (
                            <VscodeOption key={option} value={option}>
                                {option}
                            </VscodeOption>
                        ))}
                    </VscodeSingleSelect>
                )
            }
            return (
                <VscodeTextarea
                    style={{ height: "unset" }}
                    value={vs}
                    required={required}
                    rows={rows(vs)}
                    spellCheck={false}
                    placeholder={field.default}
                    onInput={(e) => {
                        const target = e.target as HTMLTextAreaElement
                        target.rows = rows(target.value)
                    }}
                    onChange={(e) => {
                        const target = e.target as HTMLInputElement
                        onChange(target.value)
                    }}
                />
            )
        }
        case "boolean":
            return (
                <VscodeCheckbox
                    checked={value as boolean}
                    required={required}
                    onChange={(e) => {
                        const target = e.target as HTMLInputElement
                        onChange(target.checked)
                    }}
                />
            )
        default:
            return (
                <VscodeTextfield
                    spellCheck={false}
                    value={value as string}
                    required={required}
                    onChange={(e) => {
                        const target = e.target as HTMLInputElement
                        onChange(target.value)
                    }}
                />
            )
    }
}

function JSONSchemaObjectForm(props: {
    schema: JSONSchemaObject
    value: any
    onChange: Dispatch<SetStateAction<any>>
    fieldPrefix: string
}) {
    const { schema, value, onChange, fieldPrefix } = props
    const properties: Record<string, JSONSchemaSimpleType> =
        schema.properties ?? ({} as any)

    const handleFieldChange = (fieldName: string, value: any) => {
        onChange((prev: any) => ({
            ...prev,
            [fieldName]: value,
        }))
    }

    return (
        <VscodeFormContainer>
            {Object.entries(properties).map(([fieldName, field]) => (
                <VscodeFormGroup key={fieldPrefix + fieldName}>
                    <VscodeLabel>
                        {underscore(fieldPrefix + fieldName).replaceAll(
                            /[_\.]/g,
                            " "
                        )}
                    </VscodeLabel>
                    <JSONSchemaSimpleTypeFormField
                        field={field}
                        value={value[fieldPrefix + fieldName]}
                        required={schema.required?.includes(fieldName)}
                        onChange={(value) =>
                            handleFieldChange(fieldPrefix + fieldName, value)
                        }
                    />
                    {field?.description && (
                        <VscodeFormHelper>{field.description}</VscodeFormHelper>
                    )}
                </VscodeFormGroup>
            ))}
        </VscodeFormContainer>
    )
}

function CounterBadge(props: { collection: any | undefined }) {
    const { collection } = props
    let count: string | undefined = undefined
    if (Array.isArray(collection)) {
        if (collection.length > 0) count = "" + collection.length
    } else if (collection) count = "1"

    return count ? (
        <VscodeBadge variant="counter" slot="content-after">
            {count}
        </VscodeBadge>
    ) : (
        ""
    )
}

function TraceMarkdown() {
    const trace = useTrace()
    return (
        <VscodeScrollable>
            <Markdown>{trace}</Markdown>
        </VscodeScrollable>
    )
}

function TraceTabPanel(props: { selected?: boolean }) {
    const { selected } = props
    return (
        <>
            <VscodeTabHeader slot="header">Trace</VscodeTabHeader>
            <VscodeTabPanel>
                {selected ? <TraceMarkdown /> : null}
            </VscodeTabPanel>
        </>
    )
}

function OutputMarkdown() {
    const output = useOutput()
    return (
        <VscodeScrollable>
            <MarkdownWithPreview>{output}</MarkdownWithPreview>
        </VscodeScrollable>
    )
}

function OutputTraceTabPanel(props: { selected?: boolean }) {
    const { selected } = props
    return (
        <>
            <VscodeTabHeader slot="header">Output</VscodeTabHeader>
            <VscodeTabPanel>
                {selected ? <OutputMarkdown /> : null}
            </VscodeTabPanel>
        </>
    )
}

function ProblemsTabPanel() {
    const result = useResult()
    const { annotations = [] } = result || {}
    const annotationsMarkdown = annotations
        .map(convertAnnotationToItem)
        .join("\n")

    return (
        <>
            <VscodeTabHeader slot="header">
                Problems
                <CounterBadge collection={annotations} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                <Markdown>{annotationsMarkdown}</Markdown>
            </VscodeTabPanel>
        </>
    )
}

function MessagesTabPanel() {
    const result = useResult()
    const { messages = [] } = result || {}
    const md = renderMessagesToMarkdown(messages, {
        system: true,
        user: true,
        assistant: true,
    })
    return (
        <>
            <VscodeTabHeader slot="header">
                Chat
                <CounterBadge collection={messages} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                <Markdown>{md}</Markdown>
            </VscodeTabPanel>
        </>
    )
}

function renderCost(value: number) {
    if (!value) return ""
    return value <= 0.01
        ? `${(value * 100).toFixed(3)}¢`
        : value <= 0.1
          ? `${(value * 100).toFixed(2)}¢`
          : `${value.toFixed(2)}$`
}

function StatsTabPanel() {
    const result = useResult()
    const { stats } = result || {}
    const { cost, ...rest } = stats || {}

    const md = stats ? YAMLStringify(rest) : ""
    return (
        <>
            <VscodeTabHeader slot="header">
                Stats
                {!!cost && (
                    <VscodeBadge variant="counter" slot="content-after">
                        {renderCost(cost)}
                    </VscodeBadge>
                )}
            </VscodeTabHeader>
            <VscodeTabPanel>
                {md ? <Markdown>{fenceMD(md, "yaml")}</Markdown> : null}
            </VscodeTabPanel>
        </>
    )
}

function LogProbsTabPanel() {
    const result = useResult()
    const { options } = useApi()
    const { logprobs } = result || {}
    if (!options.logprobs) return null
    const md = logprobs?.map((lp) => logprobToMarkdown(lp)).join("\n")
    return (
        <>
            <VscodeTabHeader slot="header">
                Perplexity
                <CounterBadge collection={md} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                <Markdown>{md}</Markdown>
            </VscodeTabPanel>
        </>
    )
}

function TopLogProbsTabPanel() {
    const result = useResult()
    const { options } = useApi()
    const { logprobs } = result || {}
    if (!options.logprobs || !(options.topLogprobs > 1)) return null
    const md = logprobs?.map((lp) => topLogprobsToMarkdown(lp)).join("\n")
    return (
        <>
            <VscodeTabHeader slot="header">
                Entropy
                <CounterBadge collection={md} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                <Markdown>{md}</Markdown>
            </VscodeTabPanel>
        </>
    )
}

function FileEditsTabPanel() {
    const result = useResult()
    const { fileEdits = {} } = result || {}
    const files = Object.entries(fileEdits)

    return (
        <>
            <VscodeTabHeader slot="header">
                Edits
                <CounterBadge collection={files} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                <Markdown>
                    {files
                        ?.map(
                            ([filename, content], i) =>
                                dedent`### ${filename}
                    ${markdownDiff(content.before, content.after, { lang: "txt" })}
                    ${content.validation?.pathValid ? `- output path validated` : ""}
                    ${
                        content.validation?.schema
                            ? dedent`- JSON schema
                        \`\`\`json
                        ${JSON.stringify(content.validation.schema, null, 2)}
                        \`\`\``
                            : ""
                    }
                    ${content.validation?.schemaError ? `- error: ${content.validation.schemaError}` : ""}
                    `
                        )
                        .join("\n")}
                </Markdown>
            </VscodeTabPanel>
        </>
    )
}

function DataTabPanel() {
    const result = useResult()
    const { frames = [] } = result || {}

    return (
        <>
            <VscodeTabHeader slot="header">
                Data
                <CounterBadge collection={frames} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                {frames.map((frame, i) => (
                    <Markdown key={i}>
                        {`
\`\`\`\`\`json
${JSON.stringify(frame, null, 2)}}
\`\`\`\`\`
`}
                    </Markdown>
                ))}
            </VscodeTabPanel>
        </>
    )
}

function JSONTabPanel() {
    const result = useResult()
    const { json } = result || {}
    return (
        <>
            <VscodeTabHeader slot="header">
                JSON
                <CounterBadge collection={json} />
            </VscodeTabHeader>
            <VscodeTabPanel>
                {json && (
                    <Markdown>
                        {`
\`\`\`\`\`json
${JSON.stringify(json, null, 2)}}
\`\`\`\`\`
`}
                    </Markdown>
                )}
            </VscodeTabPanel>
        </>
    )
}

function RawTabPanel() {
    const result = useResult()
    return (
        <>
            <VscodeTabHeader slot="header">Raw</VscodeTabHeader>
            <VscodeTabPanel>
                {result && (
                    <Markdown>
                        {`
\`\`\`\`\`json
${JSON.stringify(result, null, 2)}}
\`\`\`\`\`
`}
                    </Markdown>
                )}
            </VscodeTabPanel>
        </>
    )
}

function toStringList(...token: (string | undefined | null)[]) {
    const md = token
        .filter((l) => l !== undefined && l !== null && l !== "")
        .join(", ")
    return md
}

function acceptToAccept(accept: string | undefined) {
    if (!accept) return undefined
    const res: Record<string, string[]> = {}
    const extensions = accept.split(",")
    for (const ext of extensions) {
        const mime = lookupMime(ext)
        if (mime) {
            const exts = res[mime] || (res[mime] = [])
            if (!exts.includes(ext)) exts.push(ext)
        }
    }
    return res
}

function FilesDropZone() {
    const script = useScript()
    const { accept } = script || {}
    const { acceptedFiles, isDragActive, getRootProps, getInputProps } =
        useDropzone({ multiple: true, accept: acceptToAccept(accept) })
    const { importedFiles, setImportedFiles } = useApi()

    useEffect(() => {
        const newImportedFiles = [...importedFiles]
        if (acceptedFiles?.length) {
            for (const f of acceptedFiles)
                if (!newImportedFiles.find((nf) => nf.path === f.path)) {
                    ;(f as ImportedFile).selected = true
                    newImportedFiles.push(f)
                }
        }
        if (newImportedFiles.length !== importedFiles.length)
            setImportedFiles(newImportedFiles)
    }, [importedFiles, acceptedFiles])

    return (
        <>
            <VscodeFormGroup>
                <VscodeLabel>Files</VscodeLabel>
                <VscodeMultiSelect
                    onChange={(e) => {
                        e.preventDefault()
                        const target = e.target as VscodeMultiSelectElement
                        const newImportedFiles = [...importedFiles]
                        const selected = target.selectedIndexes
                        for (let i = 0; i < newImportedFiles.length; i++) {
                            newImportedFiles[i].selected = selected.includes(i)
                        }
                        setImportedFiles(newImportedFiles)
                    }}
                >
                    {importedFiles.map((file) => (
                        <VscodeOption
                            key={file.path}
                            value={file.path}
                            selected={file.selected}
                        >
                            {file.name} ({prettyBytes(file.size)})
                        </VscodeOption>
                    ))}
                </VscodeMultiSelect>
            </VscodeFormGroup>
            <VscodeFormGroup
                style={{
                    cursor: "pointer",
                }}
                {...getRootProps({ className: "dropzone" })}
            >
                <input {...getInputProps()} />
                <VscodeFormHelper>
                    {isDragActive
                        ? `Drop the files here ...`
                        : `Drag 'n' drop some files here, or click to select files`}
                </VscodeFormHelper>
            </VscodeFormGroup>
        </>
    )
}

function GlobsForm() {
    const { files = [], setFiles } = useApi()
    return (
        <VscodeFormContainer>
            <VscodeFormGroup>
                <VscodeLabel>Globs</VscodeLabel>
                <VscodeTextarea
                    value={files.join(", ")}
                    label="List of files glob patterns, one per line"
                    onChange={(e) => {
                        const target = e.target as HTMLInputElement
                        startTransition(() => setFiles(target.value.split(",")))
                    }}
                />
            </VscodeFormGroup>
        </VscodeFormContainer>
    )
}

function RemoteInfo() {
    const { remote } = useEnv() || {}
    if (!remote?.url) return null

    const { url, branch } = remote
    const value = `${url}#${branch}`
    return (
        <VscodeFormGroup>
            <VscodeLabel>Remote</VscodeLabel>
            <VscodeTextfield
                readonly={true}
                disabled={true}
                value={value}
            ></VscodeTextfield>
            <VscodeFormHelper>
                Running GenAIScript on a clone of this repository.
            </VscodeFormHelper>
        </VscodeFormGroup>
    )
}

function ScriptSelect() {
    const scripts = useScripts()
    const { scriptid, setScriptid } = useApi()
    const script = useScript()

    return (
        <VscodeFormGroup>
            <VscodeLabel style={{ padding: 0 }}>
                <GenAIScriptLogo height="2em" />
            </VscodeLabel>
            <VscodeSingleSelect
                value={scriptid}
                required={true}
                combobox
                filter="fuzzy"
                onChange={(e) => {
                    const target = e.target as HTMLSelectElement
                    setScriptid(target.value)
                }}
            >
                {scripts
                    .filter((s) => !s.isSystem && !s.unlisted)
                    .map(({ id, title }) => (
                        <VscodeOption
                            value={id}
                            selected={scriptid === id}
                            description={title}
                        >
                            {id}
                        </VscodeOption>
                    ))}
            </VscodeSingleSelect>
            {script && (
                <VscodeFormHelper>
                    {toStringList(
                        script.title,
                        script.description,
                        script.filename
                    )}
                </VscodeFormHelper>
            )}
        </VscodeFormGroup>
    )
}

function ScriptForm() {
    return (
        <VscodeCollapsible open title="Script">
            <VscodeFormContainer>
                <RemoteInfo />
                <ScriptSelect />
                <FilesDropZone />
                <PromptParametersFields />
                <RunButton />
            </VscodeFormContainer>
        </VscodeCollapsible>
    )
}

function ScriptSourcesView() {
    const script = useScript()
    const { jsSource, text, filename } = script || {}
    return (
        <VscodeCollapsible title="Source">
            {filename ? <Markdown>{`- ${filename}`}</Markdown> : null}
            {text ? (
                <Markdown>{`\`\`\`\`\`\`
${text.trim()}
\`\`\`\`\`\``}</Markdown>
            ) : null}
            {jsSource ? (
                <Markdown>
                    {`\`\`\`\`\`\`js
${jsSource.trim()}
\`\`\`\`\`\``}
                </Markdown>
            ) : null}
        </VscodeCollapsible>
    )
}

function PromptParametersFields() {
    const script = useScript()

    const { parameters, setParameters } = useApi()
    const { inputSchema } = script || {}
    if (!Object.keys(inputSchema?.properties || {}).length) return null

    const scriptParameters = inputSchema.properties[
        "script"
    ] as JSONSchemaObject
    const systemParameters = Object.entries(inputSchema.properties).filter(
        ([k]) => k !== "script"
    )

    return (
        <>
            {scriptParameters && (
                <VscodeCollapsible title="Parameters" open>
                    <JSONSchemaObjectForm
                        schema={scriptParameters}
                        value={parameters}
                        fieldPrefix={""}
                        onChange={setParameters}
                    />
                </VscodeCollapsible>
            )}
            {!!systemParameters.length && (
                <VscodeCollapsible title="System Parameters">
                    {Object.entries(inputSchema.properties)
                        .filter(([k]) => k !== "script")
                        .map(([key, fieldSchema]) => {
                            return (
                                <JSONSchemaObjectForm
                                    schema={fieldSchema as JSONSchemaObject}
                                    value={parameters}
                                    fieldPrefix={`${key}.`}
                                    onChange={setParameters}
                                />
                            )
                        })}
                </VscodeCollapsible>
            )}
        </>
    )
}

function ModelConnectionOptionsForm() {
    const { options, setOptions } = useApi()
    const env = useEnv()
    const { providers } = env || {}

    const schema: JSONSchemaObject = {
        type: "object",
        properties: {
            cache: {
                type: "boolean",
                description: `Enable cache for LLM requests`,
                default: false,
            },
            provider: {
                type: "string",
                description: "LLM provider",
                enum: providers
                    .filter((p) => !p.error)
                    .sort((l, r) => l.provider.localeCompare(r.provider))
                    .map((p) => p.provider),
                default: "openai",
            },
            model: {
                type: "string",
                description: "large model id",
                default: "large",
            },
            smallModel: {
                type: "string",
                description: "small model id",
                default: "small",
            },
            visionModel: {
                type: "string",
                description: "vision model id",
                default: "vision",
            },
            temperature: {
                type: "number",
                description: "LLM temperature from 0 to 2",
                minimum: 0,
                maximum: 2,
                default: 0.8,
            },
            logprobs: {
                type: "boolean",
                description:
                    "Enable reporting log probabilities for each token",
                default: false,
            },
            topLogprobs: {
                type: "integer",
                description:
                    "Enables reporting log probabilities for alternate tokens",
                minimum: 0,
                maximum: 5,
                default: 0,
            },
        },
    }
    return (
        <VscodeCollapsible title="Model Options">
            <JSONSchemaObjectForm
                schema={schema}
                value={options}
                fieldPrefix=""
                onChange={setOptions}
            />
        </VscodeCollapsible>
    )
}

function RunButton() {
    const { scriptid, options } = useApi()
    const { state } = useRunner()
    const disabled = !scriptid

    return (
        <VscodeFormGroup>
            <VscodeLabel></VscodeLabel>
            <VscodeButton disabled={disabled} type="submit">
                {state === "running" ? "Abort" : "Run"}
            </VscodeButton>
            <VscodeFormHelper>
                {Object.entries(options)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(", ")}
            </VscodeFormHelper>
        </VscodeFormGroup>
    )
}

function RunForm() {
    const { run, cancel, state } = useRunner()
    const action = state === "running" ? cancel : run
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        action()
    }

    return (
        <form onSubmit={handleSubmit}>
            <ScriptForm />
            <ScriptSourcesView />
            <ModelConnectionOptionsForm />
        </form>
    )
}

function ResultsTabs() {
    const [selected, setSelected] = useState(0)
    return (
        <VscodeTabs
            onVscTabsSelect={(e) => setSelected(e.detail.selectedIndex)}
            panel
        >
            <OutputTraceTabPanel selected={selected === 0} />
            <TraceTabPanel selected={selected === 1} />
            <MessagesTabPanel />
            <ProblemsTabPanel />
            <LogProbsTabPanel />
            <TopLogProbsTabPanel />
            <FileEditsTabPanel />
            <JSONTabPanel />
            <StatsTabPanel />
            <RawTabPanel />
        </VscodeTabs>
    )
}

function WebApp() {
    switch (viewMode) {
        case "results":
            return <ResultsTabs />
        default:
            return (
                <>
                    <RunForm />
                    <VscodeCollapsible open title="Results">
                        <ResultsTabs />
                    </VscodeCollapsible>
                </>
            )
    }
}

export default function App() {
    return (
        <ApiProvider>
            <RunnerProvider>
                <Suspense fallback={<VscodeProgressRing />}>
                    <WebApp />
                </Suspense>
            </RunnerProvider>
        </ApiProvider>
    )
}
