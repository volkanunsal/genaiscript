import { assert } from "node:console"
import {
    GITHUB_API_VERSION,
    GITHUB_PULL_REQUEST_REVIEW_COMMENT_LINE_DISTANCE,
    GITHUB_TOKEN,
} from "./constants"
import { createFetch } from "./fetch"
import { runtimeHost } from "./host"
import { link, prettifyMarkdown } from "./markdown"
import { logError, logVerbose, normalizeInt } from "./util"

export interface GithubConnectionInfo {
    token: string
    apiUrl?: string
    repository: string
    owner: string
    repo: string
    ref?: string
    sha?: string
    issue?: number
    runId?: string
    runUrl?: string
    commitSha?: string
}

export function githubParseEnv(
    env: Record<string, string>
): GithubConnectionInfo {
    const token = env.GITHUB_TOKEN
    const apiUrl = env.GITHUB_API_URL || "https://api.github.com"
    const repository = env.GITHUB_REPOSITORY
    const [owner, repo] = repository?.split("/", 2) || [undefined, undefined]
    const ref = env.GITHUB_REF
    const sha = env.GITHUB_SHA
    const commitSha = env.GITHUB_COMMIT_SHA
    const runId = env.GITHUB_RUN_ID
    const serverUrl = env.GITHUB_SERVER_URL
    const runUrl =
        serverUrl && runId
            ? `${serverUrl}/${repository}/actions/runs/${runId}`
            : undefined
    const issue = normalizeInt(
        env.GITHUB_ISSUE ??
            /^refs\/pull\/(?<issue>\d+)\/merge$/.exec(ref || "")?.groups?.issue
    )

    return {
        token,
        apiUrl,
        repository,
        owner,
        repo,
        ref,
        sha,
        issue,
        runId,
        runUrl,
        commitSha,
    }
}

// https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#update-a-pull-request
export async function githubUpdatePullRequestDescription(
    script: PromptScript,
    info: GithubConnectionInfo,
    text: string,
    commentTag: string
) {
    const { apiUrl, repository, issue } = info
    assert(commentTag)

    if (!issue) return { updated: false, statusText: "missing issue number" }
    const token = await runtimeHost.readSecret(GITHUB_TOKEN)
    if (!token) return { updated: false, statusText: "missing github token" }

    text = prettifyMarkdown(text)
    text += generatedByFooter(script, info)

    const fetch = await createFetch({ retryOn: [] })
    const url = `${apiUrl}/repos/${repository}/pulls/${issue}`
    // get current body
    const resGet = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
    })
    const resGetJson = (await resGet.json()) as { body: string }
    const body = mergeDescription(commentTag, resGetJson.body, text)
    const res = await fetch(url, {
        method: "PATCH",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({ body }),
    })
    const r = {
        updated: res.status === 200,
        statusText: res.statusText,
    }

    if (!r.updated)
        logError(
            `pull request ${info.repository}/pull/${info.issue} update failed, ${r.statusText}`
        )
    else
        logVerbose(`pull request ${info.repository}/pull/${info.issue} updated`)

    return r
}

export function mergeDescription(
    commentTag: string,
    body: string,
    text: string
) {
    body = body ?? ""
    const tag = `<!-- genaiscript begin ${commentTag} -->`
    const endTag = `<!-- genaiscript end ${commentTag} -->`
    const sep = "\n\n"

    const start = body.indexOf(tag)
    const end = body.indexOf(endTag)
    if (start > -1 && end > -1 && start < end) {
        body =
            body.slice(0, start + tag.length) +
            sep +
            text +
            sep +
            body.slice(end)
    } else {
        body = body + sep + tag + sep + text + sep + endTag + sep
    }
    return body
}

export function generatedByFooter(
    script: PromptScript,
    info: { runUrl?: string },
    code?: string
) {
    return `\n\n> generated by ${link(script.id, info.runUrl)}${code ? ` \`${code}\` ` : ""}\n\n`
}

export function appendGeneratedComment(
    script: PromptScript,
    info: { runUrl?: string },
    annotation: Diagnostic
) {
    const { message, code, severity } = annotation
    return prettifyMarkdown(
        `<!-- genaiscript ${severity} ${code || ""} -->
${message}
${generatedByFooter(script, info, code)}`
    )
}

// https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#create-an-issue-comment
export async function githubCreateIssueComment(
    script: PromptScript,
    info: GithubConnectionInfo,
    body: string,
    commentTag: string
): Promise<{ created: boolean; statusText: string; html_url?: string }> {
    const { apiUrl, repository, issue } = info

    if (!issue) return { created: false, statusText: "missing issue number" }
    const token = await runtimeHost.readSecret(GITHUB_TOKEN)
    if (!token) return { created: false, statusText: "missing github token" }

    const fetch = await createFetch({ retryOn: [] })
    const url = `${apiUrl}/repos/${repository}/issues/${issue}/comments`

    body += generatedByFooter(script, info)

    if (commentTag) {
        const tag = `<!-- genaiscript ${commentTag} -->`
        body = `${body}\n\n${tag}\n\n`
        // try to find the existing comment
        const resListComments = await fetch(
            `${url}?per_page=100&sort=updated`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": GITHUB_API_VERSION,
                },
            }
        )
        if (resListComments.status !== 200)
            return { created: false, statusText: resListComments.statusText }
        const comments = (await resListComments.json()) as {
            id: string
            body: string
        }[]
        const comment = comments.find((c) => c.body.includes(tag))
        if (comment) {
            const delurl = `${apiUrl}/repos/${repository}/issues/comments/${comment.id}`
            const resd = await fetch(delurl, {
                method: "DELETE",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": GITHUB_API_VERSION,
                },
            })
            if (!resd.ok)
                logError(`issue comment delete failed, ` + resd.statusText)
        }
    }

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({ body }),
    })
    const resp: { id: string; html_url: string } = await res.json()
    const r = {
        created: res.status === 201,
        statusText: res.statusText,
        html_url: resp.html_url,
    }
    if (!r.created)
        logError(
            `pull request ${issue} comment creation failed, ${r.statusText}`
        )
    else logVerbose(`pull request ${issue} comment created at ${r.html_url}`)

    return r
}

async function githubCreatePullRequestReview(
    script: PromptScript,
    info: GithubConnectionInfo,
    token: string,
    annotation: Diagnostic,
    existingComments: { id: string; path: string; line: number; body: string }[]
) {
    assert(token)
    const { apiUrl, repository, issue, commitSha } = info

    const prettyMessage = prettifyMarkdown(annotation.message)
    const line = annotation.range?.[1]?.[0] + 1
    const body = {
        body: appendGeneratedComment(script, info, annotation),
        commit_id: commitSha,
        path: annotation.filename,
        line: normalizeInt(line),
        side: "RIGHT",
    }
    if (
        existingComments.find(
            (c) =>
                c.path === body.path &&
                Math.abs(c.line - body.line) <
                    GITHUB_PULL_REQUEST_REVIEW_COMMENT_LINE_DISTANCE &&
                (annotation.code
                    ? c.body?.includes(annotation.code)
                    : c.body?.includes(prettyMessage))
        )
    ) {
        logVerbose(
            `pull request ${commitSha} comment creation already exists, skipping`
        )
        return { created: false, statusText: "comment already exists" }
    }
    const fetch = await createFetch({ retryOn: [] })
    const url = `${apiUrl}/repos/${repository}/pulls/${issue}/comments`
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify(body),
    })
    const resp: { id: string; html_url: string } = await res.json()
    const r = {
        created: res.status === 201,
        statusText: res.statusText,
        html_url: resp.html_url,
    }
    if (!r.created) {
        logVerbose(
            `pull request ${commitSha} comment creation failed, ${r.statusText}`
        )
    } else
        logVerbose(`pull request ${commitSha} comment created at ${r.html_url}`)
    return r
}

export async function githubCreatePullRequestReviews(
    script: PromptScript,
    info: GithubConnectionInfo,
    annotations: Diagnostic[]
): Promise<boolean> {
    const { repository, issue, sha, apiUrl } = info

    if (!annotations?.length) return true
    if (!issue) {
        logError("missing pull request number")
        return false
    }
    if (!sha) {
        logError("missing commit sha")
        return false
    }
    const token = await runtimeHost.readSecret(GITHUB_TOKEN)
    if (!token) {
        logError("missing github token")
        return false
    }

    // query existing reviews
    const fetch = await createFetch({ retryOn: [] })
    const url = `${apiUrl}/repos/${repository}/pulls/${issue}/comments`
    const resListComments = await fetch(`${url}?per_page=100&sort=updated`, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
    })
    if (resListComments.status !== 200) return false
    const comments = (await resListComments.json()) as {
        id: string
        path: string
        line: number
        body: string
    }[]
    // code annotations
    for (const annotation of annotations) {
        await githubCreatePullRequestReview(
            script,
            info,
            token,
            annotation,
            comments
        )
    }
    return true
}
