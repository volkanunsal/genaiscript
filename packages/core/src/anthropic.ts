import {
    ChatCompletionHandler,
    LanguageModel,
    LanguageModelInfo,
    ListModelsFunction,
} from "./chat"
import {
    ANTHROPIC_MAX_TOKEN,
    MODEL_PROVIDER_ANTHROPIC,
    MODEL_PROVIDER_ANTHROPIC_BEDROCK,
} from "./constants"
import { LanguageModelConfiguration } from "./host"
import { parseModelIdentifier } from "./models"
import { NotSupportedError, serializeError } from "./error"
import { estimateTokens } from "./tokens"
import { resolveTokenEncoder } from "./encoders"
import type { Anthropic } from "@anthropic-ai/sdk"

import {
    ChatCompletionResponse,
    ChatCompletionToolCall,
    ChatCompletionUsage,
    ChatCompletionMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionTool,
    ChatFinishReason,
    ChatCompletionContentPartImage,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
} from "./chattypes"

import { deleteUndefinedValues, logError, logVerbose } from "./util"
import { resolveHttpProxyAgent } from "./proxy"
import {
    ChatCompletionRequestCacheKey,
    getChatCompletionCache,
} from "./chatcache"
import { HttpsProxyAgent } from "https-proxy-agent"
import { MarkdownTrace } from "./trace"
import { createFetch, FetchType } from "./fetch"

const convertFinishReason = (
    stopReason: Anthropic.Message["stop_reason"]
): ChatFinishReason => {
    switch (stopReason) {
        case "end_turn":
            return "stop"
        case "max_tokens":
            return "length"
        case "stop_sequence":
            return "stop"
        case "tool_use":
            return "tool_calls"
        default:
            return undefined
    }
}

const convertUsage = (
    usage:
        | Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaUsage
        | undefined
): ChatCompletionUsage | undefined => {
    if (!usage) return undefined
    const res = {
        prompt_tokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0),
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
    } as ChatCompletionUsage
    if (usage.cache_read_input_tokens)
        res.prompt_tokens_details = {
            cached_tokens: usage.cache_read_input_tokens,
        }
    return res
}
const adjustUsage = (
    usage: ChatCompletionUsage,
    outputTokens: Anthropic.MessageDeltaUsage
): ChatCompletionUsage => {
    return {
        ...usage,
        completion_tokens: usage.completion_tokens + outputTokens.output_tokens,
        total_tokens: usage.total_tokens + outputTokens.output_tokens,
    }
}

const convertMessages = (
    messages: ChatCompletionMessageParam[]
): Array<Anthropic.Beta.PromptCaching.PromptCachingBetaMessageParam> => {
    return messages.map(convertSingleMessage)
}

const convertSingleMessage = (
    msg: ChatCompletionMessageParam
): Anthropic.Messages.MessageParam => {
    const { role } = msg
    if (!role || role === "aici") {
        // Handle AICIRequest or other custom types
        return {
            role: "user",
            content: [{ type: "text", text: JSON.stringify(msg) }],
        }
    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        return convertToolCallMessage({
            ...msg,
            tool_calls: msg.tool_calls,
        })
    } else if (role === "tool") {
        return convertToolResultMessage(msg)
    } else if (role === "function")
        throw new NotSupportedError("function message not supported")

    return convertStandardMessage(msg)
}

function toCacheControl(msg: ChatCompletionMessageParam): {
    type: "ephemeral"
} {
    return msg.cacheControl === "ephemeral" ? { type: "ephemeral" } : undefined
}

const convertToolCallMessage = (
    msg: ChatCompletionAssistantMessageParam
): Anthropic.Beta.PromptCaching.PromptCachingBetaMessageParam => {
    return {
        role: "assistant",
        content: msg.tool_calls.map(
            (tool) =>
                deleteUndefinedValues({
                    type: "tool_use",
                    id: tool.id,
                    input: JSON.parse(tool.function.arguments),
                    name: tool.function.name,
                    cache_control: toCacheControl(msg),
                }) satisfies Anthropic.Beta.PromptCaching.PromptCachingBetaToolUseBlockParam
        ),
    }
}

const convertToolResultMessage = (
    msg: ChatCompletionToolMessageParam
): Anthropic.Beta.PromptCaching.PromptCachingBetaMessageParam => {
    return {
        role: "user",
        content: [
            deleteUndefinedValues({
                type: "tool_result",
                tool_use_id: msg.tool_call_id,
                content: msg.content,
                cache_control: toCacheControl(msg),
            } satisfies Anthropic.Beta.PromptCaching.PromptCachingBetaToolResultBlockParam),
        ],
    }
}

const convertStandardMessage = (
    msg:
        | ChatCompletionSystemMessageParam
        | ChatCompletionAssistantMessageParam
        | ChatCompletionUserMessageParam
): Anthropic.Beta.PromptCaching.PromptCachingBetaMessageParam => {
    const role = msg.role === "assistant" ? "assistant" : "user"
    if (Array.isArray(msg.content)) {
        return {
            role,
            content: msg.content
                .map((block) => {
                    const cache_control = toCacheControl(msg)
                    if (typeof block === "string") {
                        return {
                            type: "text",
                            text: block,
                            cache_control,
                        } satisfies Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaTextBlockParam
                    } else if (block.type === "text") {
                        return {
                            type: "text",
                            text: block.text,
                            cache_control,
                        } satisfies Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaTextBlockParam
                    } else if (block.type === "image_url") {
                        return convertImageUrlBlock(block)
                    }
                    // audio?
                    // Handle other types or return a default
                    else
                        return {
                            type: "text",
                            text: JSON.stringify(block),
                        } satisfies Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaTextBlockParam
                })
                .map(deleteUndefinedValues),
        }
    } else {
        return {
            role,
            content: [
                deleteUndefinedValues({
                    type: "text",
                    text: msg.content,
                    cache_control: toCacheControl(msg),
                }) satisfies Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaTextBlockParam,
            ],
        }
    }
}

const convertImageUrlBlock = (
    block: ChatCompletionContentPartImage
): Anthropic.Beta.PromptCaching.PromptCachingBetaImageBlockParam => {
    return {
        type: "image",
        source: {
            type: "base64",
            media_type: block.image_url.url.startsWith("data:image/png")
                ? "image/png"
                : "image/jpeg",
            data: block.image_url.url.split(",")[1],
        },
    }
}

const convertTools = (
    tools?: ChatCompletionTool[]
): Anthropic.Messages.Tool[] | undefined => {
    if (!tools) return undefined
    return tools.map(
        (tool) =>
            ({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: {
                    type: "object",
                    ...tool.function.parameters,
                },
            }) satisfies Anthropic.Messages.Tool
    )
}

const completerFactory = (
    resolver: (
        trace: MarkdownTrace,
        cfg: LanguageModelConfiguration,
        httpAgent: HttpsProxyAgent<string>,
        fetch: FetchType,
        caching: boolean
    ) => Promise<Anthropic.Messages | Anthropic.Beta.PromptCaching.Messages>
) => {
    const completion: ChatCompletionHandler = async (
        req,
        cfg,
        options,
        trace
    ) => {
        const {
            requestOptions,
            partialCb,
            cancellationToken,
            inner,
            cacheName,
            cache: cacheOrName,
            retry,
            maxDelay,
            retryDelay,
        } = options
        const { headers } = requestOptions || {}
        const { token, source, ...cfgNoToken } = cfg
        const { model } = parseModelIdentifier(req.model)
        const { encode: encoder } = await resolveTokenEncoder(model)

        const cache = !!cacheOrName || !!cacheName
        const cacheStore = getChatCompletionCache(
            typeof cacheOrName === "string" ? cacheOrName : cacheName
        )
        const cachedKey = cache
            ? <ChatCompletionRequestCacheKey>{
                  ...req,
                  ...cfgNoToken,
                  model: req.model,
                  temperature: req.temperature,
                  top_p: req.top_p,
                  max_tokens: req.max_tokens,
                  logit_bias: req.logit_bias,
              }
            : undefined
        trace.itemValue(`caching`, cache)
        trace.itemValue(`cache`, cacheStore?.name)
        const { text: cached, finishReason: cachedFinishReason } =
            (await cacheStore.get(cachedKey)) || {}
        if (cached !== undefined) {
            partialCb?.({
                tokensSoFar: estimateTokens(cached, encoder),
                responseSoFar: cached,
                responseChunk: cached,
                inner,
            })
            trace.itemValue(`cache hit`, await cacheStore.getKeySHA(cachedKey))
            return {
                text: cached,
                finishReason: cachedFinishReason,
                cached: true,
            }
        }

        const fetch = await createFetch({
            trace,
            retries: retry,
            retryDelay,
            maxDelay,
            cancellationToken,
        })
        // https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#how-to-implement-prompt-caching
        const caching =
            /sonnet|haiku|opus/i.test(model) &&
            req.messages.some((m) => m.cacheControl === "ephemeral")
        const httpAgent = resolveHttpProxyAgent()
        const messagesApi = await resolver(
            trace,
            cfg,
            httpAgent,
            fetch,
            caching
        )
        const messages = convertMessages(req.messages)
        trace.itemValue(`caching`, caching)

        let numTokens = 0
        let chatResp = ""
        let finishReason: ChatCompletionResponse["finishReason"]
        let usage: ChatCompletionResponse["usage"] | undefined
        const toolCalls: ChatCompletionToolCall[] = []
        const tools = convertTools(req.tools)

        const mreq = deleteUndefinedValues({
            model,
            tools,
            messages,
            max_tokens: req.max_tokens || ANTHROPIC_MAX_TOKEN,
            temperature: req.temperature,
            top_p: req.top_p,
            stream: true,
        })

        trace.detailsFenced("✉️ body", mreq, "json")
        trace.appendContent("\n")

        try {
            const stream = messagesApi.stream({ ...mreq, ...headers })
            for await (const chunk of stream) {
                if (cancellationToken?.isCancellationRequested) {
                    finishReason = "cancel"
                    break
                }
                let chunkContent = ""
                switch (chunk.type) {
                    case "message_start":
                        usage = convertUsage(
                            chunk.message
                                .usage as Anthropic.Beta.PromptCaching.Messages.PromptCachingBetaUsage
                        )
                        break

                    case "content_block_start":
                        if (chunk.content_block.type === "tool_use") {
                            toolCalls[chunk.index] = {
                                id: chunk.content_block.id,
                                name: chunk.content_block.name,
                                arguments: "",
                            }
                        }
                        break

                    case "content_block_delta":
                        switch (chunk.delta.type) {
                            case "text_delta":
                                chunkContent = chunk.delta.text
                                numTokens += estimateTokens(
                                    chunkContent,
                                    encoder
                                )
                                chatResp += chunkContent
                                trace.appendToken(chunkContent)
                                break

                            case "input_json_delta":
                                toolCalls[chunk.index].arguments +=
                                    chunk.delta.partial_json
                        }
                        break
                    case "content_block_stop": {
                        break
                    }
                    case "message_delta":
                        if (chunk.delta.stop_reason) {
                            finishReason = convertFinishReason(
                                chunk.delta.stop_reason
                            )
                        }
                        if (chunk.usage) {
                            usage = adjustUsage(usage, chunk.usage)
                        }
                        break
                    case "message_stop": {
                        break
                    }
                }

                if (chunkContent)
                    partialCb?.({
                        responseSoFar: chatResp,
                        tokensSoFar: numTokens,
                        responseChunk: chunkContent,
                        inner,
                    })
            }
        } catch (e) {
            finishReason = "fail"
            logError(e)
            trace.error("error while processing event", serializeError(e))
        }

        trace.appendContent("\n\n")
        trace.itemValue(`🏁 finish reason`, finishReason)
        if (usage) {
            trace.itemValue(
                `🪙 tokens`,
                `${usage.total_tokens} total, ${usage.prompt_tokens} prompt, ${usage.completion_tokens} completion`
            )
        }

        if (finishReason === "stop")
            await cacheStore.set(cachedKey, { text: chatResp, finishReason })
        return {
            text: chatResp,
            finishReason,
            usage,
            toolCalls: toolCalls.filter((x) => x !== undefined),
        } satisfies ChatCompletionResponse
    }
    return completion
}

async function listAnthropicModels(
    _: LanguageModelConfiguration
): Promise<LanguageModelInfo[]> {
    // Anthropic doesn't expose an API to list models, so we return a static list
    // based on the Model type defined in the Anthropic SDK
    const models: Array<{ id: Anthropic.Model; details: string }> = [
        {
            id: "claude-3-5-sonnet-20240620",
            details:
                "Latest Claude 3 Sonnet model with improved capabilities and knowledge cutoff in June 2024.",
        },
        {
            id: "claude-3-opus-20240229",
            details:
                "Most capable Claude 3 model, excelling at highly complex tasks. Knowledge cutoff in February 2024.",
        },
        {
            id: "claude-3-sonnet-20240229",
            details:
                "Balanced Claude 3 model offering strong performance and speed. Knowledge cutoff in February 2024.",
        },
        {
            id: "claude-3-haiku-20240307",
            details:
                "Fastest Claude 3 model, optimized for quick responses. Knowledge cutoff in March 2024.",
        },
        {
            id: "claude-2.1",
            details:
                "Improved version of Claude 2, with enhanced capabilities and reliability.",
        },
        {
            id: "claude-2.0",
            details:
                "Original Claude 2 model with strong general capabilities.",
        },
        {
            id: "claude-instant-1.2",
            details:
                "Fast and cost-effective model for simpler tasks and high-volume use cases.",
        },
    ]

    return models.map(({ id, details }) => ({ id, details }))
}

export const AnthropicModel = Object.freeze<LanguageModel>({
    completer: completerFactory(
        async (trace, cfg, httpAgent, fetch, caching) => {
            const Anthropic = (await import("@anthropic-ai/sdk")).default
            const anthropic = new Anthropic({
                baseURL: cfg.base,
                apiKey: cfg.token,
                fetch,
                httpAgent,
            })
            if (anthropic.baseURL)
                trace.itemValue(
                    `url`,
                    `[${anthropic.baseURL}](${anthropic.baseURL})`
                )
            const messagesApi = caching
                ? anthropic.beta.promptCaching.messages
                : anthropic.messages
            return messagesApi
        }
    ),
    id: MODEL_PROVIDER_ANTHROPIC,
    listModels: listAnthropicModels,
})

export const AnthropicBedrockModel = Object.freeze<LanguageModel>({
    completer: completerFactory(
        async (trace, cfg, httpAgent, fetch, caching) => {
            const AnthropicBedrock = (await import("@anthropic-ai/bedrock-sdk"))
                .AnthropicBedrock
            const anthropic = new AnthropicBedrock({
                baseURL: cfg.base,
                fetch,
                httpAgent,
            })
            if (anthropic.baseURL)
                trace.itemValue(
                    `url`,
                    `[${anthropic.baseURL}](${anthropic.baseURL})`
                )
            const messagesApi = anthropic.messages
            return messagesApi
        }
    ),
    id: MODEL_PROVIDER_ANTHROPIC_BEDROCK,
    listModels: listAnthropicModels,
})
