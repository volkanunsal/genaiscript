import { CancellationOptions, CancellationToken } from "./cancellation"
import { LanguageModel } from "./chat"
import { Progress } from "./progress"
import { MarkdownTrace, TraceOptions } from "./trace"
import {
    AzureCredentialsType,
    LanguageModelConfiguration,
    Project,
    ResponseStatus,
} from "./server/messages"
import { HostConfiguration } from "./hostconfiguration"

// this is typically an instance of TextDecoder
export interface UTF8Decoder {
    decode(
        input: Uint8Array,
        options?: {
            stream?: boolean | undefined
        }
    ): string
}

export interface UTF8Encoder {
    encode(input: string): Uint8Array
}

export enum LogLevel {
    Verbose = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
}

export interface RetrievalClientOptions {
    progress?: Progress
    token?: CancellationToken
    trace?: MarkdownTrace
}

export interface RetrievalSearchOptions extends VectorSearchOptions {}

export interface RetrievalSearchResponse extends ResponseStatus {
    results: WorkspaceFileWithScore[]
}

export interface RetrievalService {
    vectorSearch(
        text: string,
        files: WorkspaceFile[],
        options?: RetrievalSearchOptions
    ): Promise<RetrievalSearchResponse>
}

export interface ServerManager {
    start(): Promise<void>
    close(): Promise<void>
}

export interface AuthenticationToken {
    token: string
    expiresOnTimestamp: number
}

export function isAzureTokenExpired(token: AuthenticationToken) {
    // Consider the token expired 5 seconds before the actual expiration to avoid timing issues
    return !token || token.expiresOnTimestamp < Date.now() - 5_000
}

export interface AzureTokenResolver {
    token(
        credentialsType: AzureCredentialsType,
        options?: CancellationOptions
    ): Promise<{ token?: AuthenticationToken; error?: SerializedError }>
}

export type ModelConfiguration = Readonly<
    Pick<ModelOptions, "model" | "temperature" | "reasoningEffort"> & {
        source: "cli" | "env" | "script" | "config" | "default"
        candidates?: string[]
    }
>

export type ModelConfigurations = {
    large: ModelConfiguration
    small: ModelConfiguration
    vision: ModelConfiguration
    embeddings: ModelConfiguration
} & Record<string, ModelConfiguration>

export interface Host {
    userState: any
    server: ServerManager
    path: Path

    createUTF8Decoder(): UTF8Decoder
    createUTF8Encoder(): UTF8Encoder
    projectFolder(): string
    installFolder(): string
    resolvePath(...segments: string[]): string

    getLanguageModelConfiguration(
        modelId: string,
        options?: { token?: boolean } & CancellationOptions & TraceOptions
    ): Promise<LanguageModelConfiguration | undefined>
    log(level: LogLevel, msg: string): void

    // fs
    statFile(name: string): Promise<{
        size: number
        type: "file" | "directory" | "symlink"
    }>
    readFile(name: string): Promise<Uint8Array>
    writeFile(name: string, content: Uint8Array): Promise<void>
    deleteFile(name: string): Promise<void>
    findFiles(
        pattern: string | string[],
        options?: {
            ignore?: string | string[]
            applyGitIgnore?: boolean
        }
    ): Promise<string[]>

    // This has mkdirp-semantics (parent directories are created and existing ignored)
    createDirectory(name: string): Promise<void>
    deleteDirectory(name: string): Promise<void>
}

export interface RuntimeHost extends Host {
    project: Project
    workspace: Omit<WorkspaceFileSystem, "grep" | "writeCached">
    azureToken: AzureTokenResolver
    modelAliases: Readonly<ModelConfigurations>
    clientLanguageModel?: LanguageModel

    pullModel(
        cfg: LanguageModelConfiguration,
        options?: TraceOptions & CancellationOptions
    ): Promise<ResponseStatus>

    clearModelAlias(source: "cli" | "env" | "config" | "script"): void
    setModelAlias(
        source: "env" | "cli" | "config" | "script",
        id: string,
        value: string | Omit<ModelConfiguration, "source">
    ): void

    /**
     * Reloads the configuration
     */
    readConfig(): Promise<HostConfiguration>
    /**
     * Gets the current loaded configuration
     */
    get config(): HostConfiguration
    /**
     * Reads a secret
     * @param name
     */
    readSecret(name: string): Promise<string | undefined>
    // executes a process
    exec(
        containerId: string,
        command: string,
        args: string[],
        options: ShellOptions & TraceOptions & CancellationOptions
    ): Promise<ShellOutput>

    /**
     * Starts a container to execute sandboxed code
     * @param options
     */
    container(options: ContainerOptions & TraceOptions): Promise<ContainerHost>

    /**
     * Launches a browser page
     * @param url
     * @param options
     */
    browse(
        url: string,
        options?: BrowseSessionOptions & TraceOptions
    ): Promise<BrowserPage>

    /**
     * Cleanup all temporary containers.
     */
    removeContainers(): Promise<void>

    /**
     * Cleanup all temporary browsers.
     */
    removeBrowsers(): Promise<void>

    /**
     * Asks the user to select between options
     * @param message question to ask
     * @param options options to select from
     */
    select(
        message: string,
        choices: (string | ShellSelectChoice)[],
        options?: ShellSelectOptions
    ): Promise<string>

    /**
     * Asks the user to input a text
     * @param message message to ask
     */
    input(message: string, options?: ShellInputOptions): Promise<string>

    /**
     * Asks the user to confirm a message
     * @param message message to ask
     */
    confirm(message: string, options?: ShellConfirmOptions): Promise<boolean>

    /**
     * Instantiates a content safety client
     * @param id
     */
    contentSafety(
        id?: ContentSafetyProvider,
        options?: TraceOptions
    ): Promise<ContentSafety>
}

export let host: Host
export function setHost(h: Host) {
    host = h
}
export let runtimeHost: RuntimeHost
export function setRuntimeHost(h: RuntimeHost) {
    setHost(h)
    runtimeHost = h
}
