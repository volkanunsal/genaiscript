/// <reference path="./prompt_template.d.ts"/>

// keep in sync with PromptContext!

/**
 * Console functions
 */
declare var console: PromptGenerationConsole

/**
 * Setup prompt title and other parameters.
 * Exactly one call should be present on top of .genai.js file.
 */
declare function script(options: PromptArgs): void

/**
 * Equivalent of script() for system prompts.
 */
declare function system(options: PromptSystemArgs): void

/**
 * Imports template prompt file and expands arguments in it.
 * @param files
 * @param arguments
 */
declare function importTemplate(
    files: ElementOrArray<string | WorkspaceFile>,
    arguments?: Record<string, ImportTemplateArgumentType>,
    options?: ImportTemplateOptions
): void

/**
 * Append given string to the prompt. It automatically appends "\n".
 * Typically best to use `` $`...` ``-templates instead.
 */
declare function writeText(
    body: Awaitable<string>,
    options?: WriteTextOptions
): void

/**
 * Append given string to the prompt as an assistant message.
 */
declare function assistant(
    text: Awaitable<string>,
    options?: Omit<WriteTextOptions, "assistant">
): void

/**
 * Append given string to the prompt. It automatically appends "\n".
 * `` $`foo` `` is the same as `text("foo")`.
 */
declare function $(
    strings: TemplateStringsArray,
    ...args: any[]
): PromptTemplateString

/**
 * Appends given (often multi-line) string to the prompt, surrounded in fences.
 * Similar to `text(env.fence); text(body); text(env.fence)`
 *
 * @param body string to be fenced
 */
declare function fence(body: StringLike, options?: FenceOptions): void

/**
 * Defines `name` to be the (often multi-line) string `body`.
 * Similar to `text(name + ":"); fence(body, language)`
 *
 * @param name name of defined entity, eg. "NOTE" or "This is text before NOTE"
 * @param body string to be fenced/defined
 * @returns variable name
 */
declare function def(
    name: string,
    body:
        | string
        | WorkspaceFile
        | WorkspaceFile[]
        | ShellOutput
        | Fenced
        | RunPromptResult,
    options?: DefOptions
): string

/**
 * Declares a file that is expected to be generated by the LLM
 * @param pattern file name or glob-like path
 * @param options expectations about the generated file content
 */
declare function defFileOutput(
    pattern: ElementOrArray<string | WorkspaceFile>,
    description?: string,
    options?: FileOutputOptions
): void

/**
 * Declares a tool that can be called from the prompt.
 * @param tool Agentic tool function.
 * @param name The name of the tool to be called. Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
 * @param description A description of what the function does, used by the model to choose when and how to call the function.
 * @param parameters The parameters the tool accepts, described as a JSON Schema object.
 * @param fn callback invoked when the LLM requests to run this function
 */
declare function defTool(
    tool:
        | ToolCallback
        | AgenticToolCallback
        | AgenticToolProviderCallback
        | McpServersConfig,
    options?: DefToolOptions
): void
declare function defTool(
    name: string,
    description: string,
    parameters: PromptParametersSchema | JSONSchema,
    fn: ChatFunctionHandler,
    options?: DefToolOptions
): void

/**
 * Declares a LLM agent tool that can be called from the prompt.
 * @param name name of the agent, do not prefix with agent
 * @param description description of the agent, used by the model to choose when and how to call the agent
 * @param fn prompt generation context
 * @param options additional options for the agent LLM
 */
declare function defAgent(
    name: string,
    description: string,
    fn: string | ChatAgentHandler,
    options?: DefAgentOptions
): void

/**
 * Registers a callback to be called when a file is being merged
 * @param fn
 */
declare function defFileMerge(fn: FileMergeHandler): void

/**
 * Variables coming from the fragment on which the prompt is operating.
 */
declare var env: ExpansionVariables

/**
 * Path manipulation functions.
 */
declare var path: Path

/**
 * A set of parsers for well-known file formats
 */
declare var parsers: Parsers

/**
 * Retrieval Augmented Generation services
 */
declare var retrieval: Retrieval

/**
 * Access to the workspace file system.
 */
declare var workspace: WorkspaceFileSystem

/**
 * YAML parsing and stringifying functions.
 */
declare var YAML: YAML

/**
 * INI parsing and stringifying.
 */
declare var INI: INI

/**
 * CSV parsing and stringifying.
 */
declare var CSV: CSV

/**
 * XML parsing and stringifying.
 */
declare var XML: XML

/**
 * HTML parsing
 */
declare var HTML: HTML

/**
 * Markdown and frontmatter parsing.
 */
declare var MD: MD

/**
 * JSONL parsing and stringifying.
 */
declare var JSONL: JSONL

/**
 * JSON5 parsing
 */
declare var JSON5: JSON5

/**
 * JSON Schema utilities
 */
declare var JSONSchema: JSONSchemaUtilities

/**
 * AICI operations
 */
declare var AICI: AICI

/**
 * Access to current LLM chat session information
 */
declare var host: PromptHost

/**
 * Access to GitHub queries for the current repository
 */
declare var github: GitHub

/**
 * Access to Git operations for the current repository
 */
declare var git: Git

/**
 * Access to ffmpeg operations
 */
declare var ffmpeg: Ffmpeg

/**
 * Computation around tokens
 */
declare var tokenizers: Tokenizers

/**
 * @deprecated use `host.fetchText` instead
 */
declare function fetchText(
    url: string | WorkspaceFile,
    options?: FetchTextOptions
): Promise<{ ok: boolean; status: number; text?: string; file?: WorkspaceFile }>

/**
 * Declares a JSON schema variable.
 * @param name name of the variable
 * @param schema JSON schema instance
 * @returns variable name
 */
declare function defSchema(
    name: string,
    schema: JSONSchema | ZodTypeLike,
    options?: DefSchemaOptions
): string

/**
 * Adds images to the prompt
 * @param files
 * @param options
 */
declare function defImages(
    files: ElementOrArray<BufferLike>,
    options?: DefImagesOptions
): void

/**
 * Renders a table or object in the prompt
 * @param name
 * @param data
 * @param options
 * @returns variable name
 */
declare function defData(
    name: string,
    data: Awaitable<object[] | object>,
    options?: DefDataOptions
): string

/**
 * Renders a diff of the two given values
 * @param left
 * @param right
 * @param options
 */
declare function defDiff<T extends string | WorkspaceFile>(
    name: string,
    left: T,
    right: T,
    options?: DefDiffOptions
): string

/**
 * Cancels the current prompt generation/execution with the given reason.
 * @param reason
 */
declare function cancel(reason?: string): void

/**
 * Expands and executes prompt
 * @param generator
 */
declare function runPrompt(
    generator: string | PromptGenerator,
    options?: PromptGeneratorOptions
): Promise<RunPromptResult>

/**
 * Expands and executes the prompt
 */
declare function prompt(
    strings: TemplateStringsArray,
    ...args: any[]
): RunPromptResultPromiseWithOptions

/**
 * Registers a callback to process the LLM output
 * @param fn
 */
declare function defOutputProcessor(fn: PromptOutputProcessorHandler): void

/**
 * Registers a chat participant
 * @param participant
 */
declare function defChatParticipant(
    participant: ChatParticipantHandler,
    options?: ChatParticipantOptions
): void

/**
 * Transcribes audio to text.
 * @param audio An audio file to transcribe.
 * @param options
 */
declare function transcribe(
    audio: string | WorkspaceFile,
    options?: TranscriptionOptions
): Promise<TranscriptionResult>

/**
 * Converts text to speech.
 * @param text
 * @param options
 */
declare function speak(
    text: string,
    options?: SpeechOptions
): Promise<SpeechResult>
