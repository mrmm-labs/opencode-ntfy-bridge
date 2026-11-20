import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { closeFences, markdownToHtml, splitReply } from "./telegram-markdown.ts"

const wellFormed = (html: string) => {
  const stack: string[] = []
  for (const m of html.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced </${m[2]}>`)
    else stack.push(m[2])
  }
  assert.deepEqual(stack, [])
  const text = html
    .replace(/<\/?[a-z]+(?:\s[^>]*)?>/g, "")
    .replace(/&(amp|lt|gt|quot);/g, "")
  assert.doesNotMatch(text, /[<>&]/)
}

describe("markdownToHtml", () => {
  it("formats code, bold, italic, links, lists, headings and quotes", () => {
    const html = markdownToHtml(
      "# Title\nSome **bold**, *it*, `a<b>&c`, ~~x~~ and [l](https://x.io/a?b=1&c=2)\n- one\n- **two**\n> quote",
    )
    assert.equal(
      html,
      [
        "<b>Title</b>",
        'Some <b>bold</b>, <i>it</i>, <code>a&lt;b&gt;&amp;c</code>, <s>x</s> and <a href="https://x.io/a?b=1&amp;c=2">l</a>',
        "• one",
        "• <b>two</b>",
        "<blockquote>quote</blockquote>",
      ].join("\n"),
    )
  })

  it("escapes HTML in text and in code, and keeps code blocks verbatim", () => {
    const html = markdownToHtml(
      '<script>alert(1)</script> & **<b>**\n\n```html\n<div class="a">**not bold**</div> &amp;\n```',
    )
    assert.match(
      html,
      /^&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; <b>&lt;b&gt;<\/b>/,
    )
    assert.match(
      html,
      /<pre><code class="language-html">&lt;div class="a"&gt;\*\*not bold\*\*&lt;\/div&gt; &amp;amp;<\/code><\/pre>/,
    )
    wellFormed(html)
  })

  it("refuses unsafe link targets and odd languages", () => {
    assert.equal(
      markdownToHtml("[x](javascript:alert(1))"),
      "[x](javascript:alert(1))",
    )
    assert.match(markdownToHtml('```a"><b>\nx\n```'), /^<pre>x<\/pre>$/)
  })

  it("never produces unbalanced tags, whatever the input", () => {
    for (const md of [
      "**a *b** c*",
      "`open",
      "*a **b* c**",
      "_a_b_",
      "~~",
      "[a](https://x.io",
      "```\nx",
      "> **q\n> r**",
    ])
      wellFormed(markdownToHtml(md))
  })

  it("closes a code fence left open by a reply still being written", () => {
    assert.equal(closeFences("hi\n```js\nlet x"), "hi\n```js\nlet x\n```")
    assert.equal(closeFences("```\nx\n```\nok"), "```\nx\n```\nok")
    wellFormed(markdownToHtml(closeFences("a\n```js\nlet x <")))
  })
})

describe("splitReply", () => {
  const para = (i: number) => `Paragraph ${i} ${"word ".repeat(40)}`

  it("is one message when it fits", () => {
    const r = splitReply("hello\n\nworld")
    assert.deepEqual(r.messages, ["hello\n\nworld"])
    assert.equal(r.rest, undefined)
  })

  it("splits between paragraphs, at most 3 messages of at most 4096 characters", () => {
    const md = Array.from({ length: 50 }, (_, i) => para(i)).join("\n\n")
    const r = splitReply(md)
    assert.ok(r.messages.length >= 2 && r.messages.length <= 3)
    for (const m of r.messages) {
      assert.ok(m.length <= 4096, String(m.length))
      assert.ok(m.startsWith("Paragraph"), "starts on a paragraph boundary")
      assert.ok(m.trimEnd().endsWith("word"), "ends on a paragraph boundary")
    }
  })

  it("returns what does not fit in three messages as rest", () => {
    const md = Array.from({ length: 200 }, (_, i) => para(i)).join("\n\n")
    const r = splitReply(md)
    assert.equal(r.messages.length, 3)
    assert.ok(r.rest && r.rest.startsWith("Paragraph"))
    const shown = r.messages.join("\n\n").match(/Paragraph \d+/g)!.length
    const left = r.rest.match(/Paragraph \d+/g)!.length
    assert.equal(shown + left, 200, "nothing lost")
  })

  it("cuts a code block on line boundaries and keeps every piece a closed block", () => {
    const code = Array.from(
      { length: 400 },
      (_, i) => `line ${i} <x> & ${"y".repeat(20)}`,
    ).join("\n")
    const r = splitReply(`intro\n\n\`\`\`go\n${code}\n\`\`\`\n\noutro`)
    assert.ok(r.messages.length >= 2)
    for (const m of r.messages) {
      assert.ok(m.length <= 4096)
      wellFormed(m)
    }
    assert.ok(r.messages.slice(1, -1).every((m) => m.startsWith("<pre>")))
  })

  it("cuts a single enormous line by characters", () => {
    const r = splitReply("x".repeat(9000))
    assert.equal(r.rest, undefined)
    assert.equal(r.messages.join("").length, 9000)
    for (const m of r.messages) assert.ok(m.length <= 4096)
  })
})
