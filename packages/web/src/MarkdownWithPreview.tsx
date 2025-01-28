import React from "react"
import { fenceMD } from "../../core/src/mkmd"
import Markdown from "./Markdown"
import { convertThinkToMarkdown } from "../../core/src/think"
import { convertAnnotationsToMarkdown } from "../../core/src/annotations"

import "@vscode-elements/elements/dist/vscode-tabs"
import "@vscode-elements/elements/dist/vscode-tab-header"
import "@vscode-elements/elements/dist/vscode-tab-panel"


export default function MarkdownWithPreview(props: {
    className?: string
    children: any
}) {
    const { className, children } = props
    const childrenAsString = typeof children === "string" ? children : ""
    if (!childrenAsString)
        return <Markdown className={className}>{children}</Markdown>

    const md = convertThinkToMarkdown(
        convertAnnotationsToMarkdown(childrenAsString)
    )

    return (
        <vscode-tabs>
            <vscode-tab-header slot="header">Preview</vscode-tab-header>
            <vscode-tab-panel>
                <Markdown className={className}>{md}</Markdown>
            </vscode-tab-panel>
            <vscode-tab-header slot="header">Source</vscode-tab-header>
            <vscode-tab-panel>
                <Markdown>{fenceMD(children, "markdown")}</Markdown>
            </vscode-tab-panel>
        </vscode-tabs>
    )
}
