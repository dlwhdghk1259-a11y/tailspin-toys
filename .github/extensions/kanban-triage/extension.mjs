import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();
let session;

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function scoreIssue(issue) {
    const labels = issue.labels.map(({ name }) => name.toLowerCase());
    const priority = labels.some((label) => label.includes("critical") || label.includes("urgent"))
        ? 100
        : labels.some((label) => label.includes("high") || label.includes("priority")) ? 60 : 0;
    const staleDays = Math.max(0, (Date.now() - Date.parse(issue.updatedAt)) / 86_400_000);
    return priority + Math.min(staleDays, 30) + issue.comments * 3;
}

async function loadIssues() {
    const { stdout } = await execFileAsync("gh", [
        "issue", "list", "--state", "open", "--limit", "100",
        "--json", "number,title,body,labels,updatedAt,comments,url",
    ], { cwd: process.cwd(), windowsHide: true });
    return JSON.parse(stdout).map((issue) => ({ ...issue, score: scoreIssue(issue) })).sort((a, b) => b.score - a.score);
}

async function attachIssue(issue) {
    await session.send({
        prompt: `Add GitHub issue #${issue.number} to the current work context. Title: ${issue.title}\nURL: ${issue.url}\nDescription:\n${issue.body || "No description provided."}`,
    });
}

function card(issue, highlighted) {
    const labels = issue.labels.map(({ name }) => name).join(", ");
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(issue.updatedAt)) / 86_400_000));
    const reason = highlighted
        ? `<p class="why"><strong>Why it is here:</strong> ${issue.comments} comment${issue.comments === 1 ? "" : "s"}${labels ? `, ${escapeHtml(labels)} label${issue.labels.length === 1 ? "" : "s"}` : ""}, and activity ${age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`} make it a likely attention candidate.</p>`
        : "";
    return `<article class="card"><div class="heading"><span>#${issue.number}</span><h3>${escapeHtml(issue.title)}</h3></div><p>${escapeHtml(issue.body || "No description provided.")}</p>${reason}<small>${escapeHtml(labels || "No labels")} · ${issue.comments} comment${issue.comments === 1 ? "" : "s"}</small><button data-testid="add-issue-${issue.number}" data-number="${issue.number}">Add to current context</button></article>`;
}

function renderHtml(issues, errorMessage) {
    const top = issues.slice(0, 3);
    const rest = issues.slice(3);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Issue triage</title><style>
    :root{color-scheme:light dark}body{margin:0;padding:24px;background:var(--background-color-default,#fff);color:var(--text-color-default,#1f2328);font:var(--text-body-medium,14px)/1.45 var(--font-sans,system-ui,sans-serif)}h1{font-size:24px;margin:0}h2{font-size:16px;margin:24px 0 12px}.intro,small{color:var(--text-color-muted,#656d76)}.intro{margin:6px 0}.grid{display:grid;gap:12px}.card{border:1px solid var(--border-color-default,#d0d7de);border-radius:10px;padding:16px}.heading{display:flex;gap:8px;align-items:baseline}.heading span{color:var(--true-color-blue,#0969da);font-weight:600}.heading h3{font-size:15px;margin:0}.card p{white-space:pre-wrap;margin:10px 0}.why{color:var(--text-color-default,#1f2328)}small{display:block;margin-bottom:12px}button{border:1px solid var(--border-color-default,#d0d7de);border-radius:6px;padding:7px 10px;background:transparent;color:inherit;cursor:pointer}button:hover{background:var(--background-color-muted,#f6f8fa)}button:focus-visible{outline:2px solid var(--color-focus-outline,#0969da);outline-offset:2px}button[disabled]{cursor:wait;opacity:.6}.error{border:1px solid var(--true-color-red,#cf222e);padding:12px;border-radius:8px;margin-top:16px}</style></head><body><main><h1>Issue triage</h1><p class="intro">The three issues most likely to need attention right now are first. Add any issue to this session's context to start working on it.</p>${errorMessage ? `<div class="error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}<section aria-labelledby="top"><h2 id="top">Needs attention now</h2><div class="grid">${top.length ? top.map((issue) => card(issue, true)).join("") : "<p>No open issues found.</p>"}</div></section><section aria-labelledby="rest"><h2 id="rest">Other open issues</h2><div class="grid">${rest.length ? rest.map((issue) => card(issue, false)).join("") : "<p>No remaining issues.</p>"}</div></section></main><script>
    document.querySelectorAll("button").forEach((button)=>button.addEventListener("click",async()=>{button.disabled=true;try{const response=await fetch("/attach",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:Number(button.dataset.number)})});const result=await response.json();if(!response.ok)throw new Error(result.error);button.textContent="Added to context"}catch(error){button.disabled=false;button.textContent=error.message}}));
    </script></body></html>`;
}

async function parseBody(request) {
    let body = "";
    for await (const chunk of request) body += chunk;
    return JSON.parse(body);
}

async function startServer() {
    let issues = [];
    let errorMessage = "";
    try {
        issues = await loadIssues();
    } catch (error) {
        errorMessage = `Could not load open issues: ${error instanceof Error ? error.message : String(error)}`;
    }
    const server = createServer((request, response) => {
        if (request.method === "POST" && request.url === "/attach") {
            parseBody(request).then(async ({ number }) => {
                const issue = issues.find((candidate) => candidate.number === number);
                if (!issue) throw new Error("Issue is not available on this board.");
                await attachIssue(issue);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ ok: true }));
            }).catch((error) => {
                response.writeHead(400, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            });
            return;
        }
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(renderHtml(issues, errorMessage));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/` };
}

session = await joinSession({
    canvases: [createCanvas({
        id: "kanban-triage",
        displayName: "Issue triage board",
        description: "A Kanban board that ranks open GitHub issues and adds selected issues to the current session context.",
        actions: [{
            name: "attach_issue",
            description: "Add an open issue to the current session context.",
            inputSchema: { type: "object", properties: { number: { type: "integer", minimum: 1 } }, required: ["number"], additionalProperties: false },
            handler: async ({ input }) => {
                const issue = (await loadIssues()).find((candidate) => candidate.number === input.number);
                if (!issue) throw new CanvasError("issue_not_found", `Open issue #${input.number} was not found.`);
                await attachIssue(issue);
                return { ok: true, number: issue.number };
            },
        }],
        open: async (ctx) => {
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = await startServer();
                servers.set(ctx.instanceId, entry);
            }
            return { title: "Issue triage board", url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) {
                servers.delete(ctx.instanceId);
                await new Promise((resolve) => entry.server.close(resolve));
            }
        },
    })],
});
