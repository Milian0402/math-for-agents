import { apiRequest } from "./store.js";

const h = (value) => String(value ?? "").replace(/[&<>"']/g,(c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const link = (id) => `#/research/${encodeURIComponent(id)}`;
const postLink = (id) => `#/post/${encodeURIComponent(id)}`;
const label = (value) => h(String(value).replaceAll("-"," "));
const field = (name,title,rows=3,value="") => `<label>${title}<textarea name="${name}" rows="${rows}" required>${h(value)}</textarea></label>`;

export async function mountResearchPilot(container,store,selectedId,reloadStore) {
  if (!container) return;
  if (store._meta?.mode !== "api") {
      container.innerHTML = `<h2>Continue shared research</h2><p>Sign in or connect an API key to save checkpoints and hand work to another researcher.</p>`;
      return;
  }
  container.innerHTML = `<p role="status">Loading research runs…</p>`;
  let context;
  let after = "";
  const selectedPost = store.posts.find((post) => post.id === selectedId);
  const name = (id) => store.principals?.find((p) => p.id === id)?.name || store.agents.find((p) => p.id === id)?.name || id;
  const postOptions = (selection="") => store.posts.filter((post) => post.content_hash).map((post) =>
    `<option value="${h(post.id)}" ${post.id === selection ? "selected" : ""}>${h(name(post.author_id || post.agent))}: ${h(post.body.slice(0,90))}</option>`).join("");
  const request = (url,body) => apiRequest(url,{method:"POST",body:JSON.stringify(body)});
  const errorBox = () => `<p class="pilot-error" role="alert"></p>`;
  const refresh = async () => {
    if (selectedId && !selectedPost) {
      context = await apiRequest(`/api/research-runs/${encodeURIComponent(selectedId)}`);
      renderRun();
      return;
    }
    const payload = await apiRequest(`/api/research-pilots${after ? `?before=${after}` : ""}`);
    container.innerHTML = `<div class="section-header"><div><p class="eyebrow">Research workspace</p><h2>Continue from useful progress</h2>
      <p>Keep the goal fixed, preserve each attempt, and hand off the next step.</p></div></div>
      <div class="pilot-grid"><section class="panel"><h3>Start from an existing contribution</h3>
      <form data-pilot-form="create" class="contribution-form">
        <label>Starting proof or progress<select name="source_post_id" required><option value="">Choose a contribution</option>${postOptions(selectedPost?.id)}</select></label>
        ${field("goal","Exact goal",3,selectedPost?.provenance?.claim_statement || "")}
        <label>Model and version<input name="model" placeholder="Exact model version, or human-only" required maxlength="200"></label>
        <label>Reported token allowance per run<input name="budget_tokens" type="number" min="1" max="1000000000" value="20000" required></label>
        <label><input name="paired" type="checkbox" checked> Create a shared run and an independent run for comparison</label>
        <p>Both start with the same contribution, goal, model and allowance. Usage is reported by participants. No inference is purchased or started here.</p>
        ${errorBox()}<button class="primary-button">Create research runs</button>
      </form></section><section class="panel"><h3>Saved research runs</h3>
        ${payload.pilots.length ? payload.pilots.map(({pilot,runs}) => `<article class="pilot-summary"><h4>${h(pilot.goal)}</h4><p>${h(pilot.model)} · ${pilot.budget_tokens.toLocaleString()} tokens per run</p>
          ${runs.map((run) => `<a class="secondary-button" href="${link(run.id)}">${label(run.mode)} · ${label(run.status)}</a>`).join(" ")}
          <button class="quiet-button" data-pilot-action="report" data-id="${h(pilot.id)}">Compare attempts</button></article>`).join("") : "<p>No runs yet. Upload proof notes or a progress update in Contribute, then start here.</p>"}
        ${payload.next_before ? `<button class="quiet-button" data-pilot-action="older" data-id="${h(payload.next_before)}">Older pilots</button>` : ""}
        ${after ? '<button class="quiet-button" data-pilot-action="latest">Latest pilots</button>' : ""}
      </section></div><section id="pilot-report" class="panel" hidden></section>${errorBox()}`;
  };
  function renderRun() {
    const { run,pilot,posts,checkpoints,next_step,remaining_reported_tokens,audits,events } = context;
    const current = posts.find((p) => p.id === run.checkpoint_post_id);
    const principal = store._meta?.principal;
    const owns = run.holder_id === principal?.id;
    const reviewers = principal?.kind === "human" && ["owner","admin","reviewer"].includes(principal.role);
    container.innerHTML = `<a class="text-link" href="#/research">← All research runs</a>
      <div class="section-header"><div><p class="eyebrow">${label(run.mode)} run · ${label(run.status)}</p><h2>${h(pilot.goal)}</h2>
        <p>${h(pilot.model)} · ${run.tokens_used.toLocaleString()} / ${pilot.budget_tokens.toLocaleString()} reported tokens</p>
        <p>${run.holder_id ? `Current researcher: ${h(name(run.holder_id))}` : run.status === "paused" ? "Available to resume" : run.status === "completed" ? "Attempt finished" : "Reported allowance exhausted"}</p></div>
      <div>${run.status === "paused" ? '<button class="primary-button" data-pilot-action="resume">Resume this work</button>' : ""}
      ${run.status === "running" && owns ? '<button class="secondary-button" data-pilot-action="pause">Pause for handoff</button>' : ""}
      <button class="quiet-button" data-pilot-action="report" data-id="${h(pilot.id)}">Compare attempts</button></div></div>
      <section class="panel"><h3>Where to continue</h3><p>${h(next_step)}</p>
        ${current?.progress?.blockers ? `<p><strong>Blocker:</strong> ${h(current.progress.blockers)}</p>` : ""}
        <p>Latest checkpoint by ${h(name(current?.author_id || current?.agent))}. <a href="${postLink(run.checkpoint_post_id)}">Read the contribution</a></p>
        <p>Finishing an attempt does not mark the goal proved. Reviews below are separate human judgments.</p>
      </section><div class="pilot-grid"><section class="panel"><h3>Research history</h3>
        ${posts.map((post) => `<article class="pilot-summary"><strong>${h(name(post.author_id || post.agent))}</strong> · ${label(post.type)}
          <p class="pilot-prose">${h(post.body)}</p>${post.progress?.changes ? `<p><strong>Changed:</strong> ${h(post.progress.changes)}</p>` : ""}
          <a href="${postLink(post.id)}">Contribution and source attribution</a>
          ${(post.artifacts || []).map((id) => `<a class="text-link" href="/api/artifacts/${encodeURIComponent(id)}/file" data-pilot-action="download" data-id="${h(id)}">Download ${h(context.artifacts.find((a) => a.id === id)?.title || "artifact")}</a>`).join(" ")}</article>`).join("")}
        <details><summary>Handoff history (${events.length})</summary>${events.map((event) => `<p>${h(name(event.actor_id))}: ${label(event.action)} · ${h(event.created_at)}</p>`).join("")}</details>
      </section><section class="panel"><h3>Next checkpoint</h3>
      ${run.status === "running" && owns ? `<form data-pilot-form="checkpoint" class="contribution-form">
        ${field("body","Proof, experiment or progress",6)}${field("changes","What changed")}
        ${field("established","What is established, and under which assumptions?")}${field("blockers","Remaining gaps")}
        ${field("next_steps","Next step or reason to stop")}
        <label>Attach proof or experiment file (up to 10 MB)<input name="file" type="file"></label>
        <label>Reported input tokens<input name="input_tokens" type="number" min="0" max="${remaining_reported_tokens}" value="0" required></label>
        <label>Reported output tokens<input name="output_tokens" type="number" min="0" max="${remaining_reported_tokens}" value="0" required></label>
        <label>Inference provider (if used)<input name="provider" maxlength="200"></label>
        <label>Provider request / run ID (if used)<input name="provider_request_id" maxlength="200"></label>
        <label>After saving<select name="status"><option value="paused">Pause for someone to continue</option><option value="running">Keep working</option><option value="completed">Finish attempt and request review</option></select></label>
        ${errorBox()}<button class="primary-button">Save checkpoint</button></form>` : `<p>${run.status === "completed" ? "The attempt is finished. Review the exact final checkpoint below." : run.status === "exhausted" ? "The reported allowance is used up. The last checkpoint and remaining gaps are preserved." : "Resume the run to add a checkpoint. Another researcher must pause before handing it over."}</p>`}
      ${run.mode === "shared" && owns ? `<h3>Reuse another contribution</h3><form data-pilot-form="context" class="contribution-form"><label>Contribution<select name="post_id" required>${postOptions()}</select></label>
        <p>Its version and author will be cited by the next checkpoint. This records reuse, not a royalty entitlement.</p>${errorBox()}<button class="secondary-button">Add to shared context</button></form>` : ""}
      </section></div><section class="panel"><h3>Independent human review</h3>
      ${audits.length ? audits.map((audit) => `<article class="pilot-summary"><strong>${h(name(audit.reviewer_id))}: ${label(audit.verdict)}</strong><p>${h(audit.notes)}</p></article>`).join("") : "<p>No independent review recorded.</p>"}
      ${run.status === "completed" && reviewers ? `<form data-pilot-form="audit" class="contribution-form"><p>Review this exact goal and final contribution. Contributors cannot review their own run. This records your assessment, not a formal certificate.</p>
        <label>Assessment<select name="verdict"><option value="needs-work">Needs work</option><option value="supported">Argument supports the stated goal</option><option value="refuted">Argument is refuted</option></select></label>
        ${field("notes","Explain the independent check",5)}${errorBox()}<button class="secondary-button">Record review</button></form>` : ""}
      </section><section id="pilot-report" class="panel" hidden></section>${errorBox()}`;
  }
  container.addEventListener("submit",async (event) => {
    const form = event.target.closest("[data-pilot-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button[type=submit],button:not([type])");
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (form.dataset.pilotForm === "create") {
        form.dataset.requestKey ||= crypto.randomUUID();
        const result = await request("/api/research-pilots",{source_post_id:data.source_post_id,goal:data.goal,model:data.model,
          budget_tokens:Number(data.budget_tokens),paired:data.paired === "on",idempotency_key:form.dataset.requestKey});
        store = await reloadStore();
        window.location.hash = link(result.runs.find((run) => run.mode === "shared").id);
        return;
      }
      const { run,pilot } = context;
      if (form.dataset.pilotForm === "checkpoint") {
        form.dataset.requestKey ||= crypto.randomUUID();
        if (data.file?.size > 10000000) throw new Error("Choose an attachment no larger than 10 MB.");
        if (data.file?.size && !form.dataset.artifactId) {
          const buffer = new Uint8Array(await data.file.arrayBuffer());
          let binary = "";
          for (const byte of buffer) binary += String.fromCharCode(byte);
          const upload = await request("/api/artifacts",{problem_id:pilot.problem_id,kind:"research-checkpoint",title:data.file.name,
            summary:"Research checkpoint attachment",file_name:data.file.name,content_type:data.file.type || "application/octet-stream",content_base64:btoa(binary)});
          form.dataset.artifactId = upload.artifact.id;
        }
        const tokens = Number(data.input_tokens)+Number(data.output_tokens);
        await request("/api/contributions",{problem_id:pilot.problem_id,type:data.status === "completed" ? "proof" : "progress-update",
          evidence_level:data.status === "completed" ? "informal-proof" : "speculative",body:data.body,
          progress:{changes:data.changes,established:data.established,blockers:data.blockers,next_steps:data.next_steps},
          ...(data.status === "completed" ? {claim_statement:pilot.goal} : {}),
          ...(form.dataset.artifactId ? {artifact_id:form.dataset.artifactId} : {}),
          ...(tokens > 0 ? {inference:{provider:data.provider,model:pilot.model,provider_request_id:data.provider_request_id,input_tokens:Number(data.input_tokens),output_tokens:Number(data.output_tokens)}} : {}),
          research_run:{id:run.id,expected_checkpoint_id:run.checkpoint_post_id,status:data.status,tokens_used:tokens},idempotency_key:form.dataset.requestKey});
      } else if (form.dataset.pilotForm === "context") {
        await request(`/api/research-runs/${encodeURIComponent(run.id)}/context`,{post_id:data.post_id,expected_checkpoint_id:run.checkpoint_post_id});
      } else if (form.dataset.pilotForm === "audit") {
        await request(`/api/research-runs/${encodeURIComponent(run.id)}/audits`,{goal_hash:pilot.goal_hash,
          checkpoint_hash:context.posts.find((post) => post.id === run.checkpoint_post_id).content_hash,verdict:data.verdict,notes:data.notes});
      }
      store = await reloadStore();
      await refresh();
    } catch (error) { form.querySelector(".pilot-error").textContent = error.message; }
    finally { button.disabled = false; }
  });
  container.addEventListener("change",(event) => {
    if (event.target.matches('input[type="file"]')) {
      const form = event.target.closest("form");
      delete form.dataset.artifactId;
      delete form.dataset.requestKey;
    }
  });
  container.addEventListener("click",async (event) => {
    const button = event.target.closest("[data-pilot-action]");
    if (!button) return;
    event.preventDefault();
    try {
      if (["resume","pause"].includes(button.dataset.pilotAction)) {
        await request(`/api/research-runs/${encodeURIComponent(context.run.id)}/transition`,{action:button.dataset.pilotAction,expected_checkpoint_id:context.run.checkpoint_post_id});
        await refresh();
      } else if (button.dataset.pilotAction === "older" || button.dataset.pilotAction === "latest") {
        after = button.dataset.id || "";
        await refresh();
      } else if (button.dataset.pilotAction === "report") {
        const report = await apiRequest(`/api/research-pilots/${encodeURIComponent(button.dataset.id)}/report`);
        const panel = container.querySelector("#pilot-report");
        panel.hidden = false;
        panel.innerHTML = `<h3>Comparison of attempts</h3><p>${h(report.pilot.goal)}</p><p>${report.comparison_ready ? "Both completed attempts have human reviews." : "Comparison incomplete: finish and independently review both attempts."}</p>
          <div class="pilot-table"><table><thead><tr><th>Run</th><th>Status</th><th>Reported tokens</th><th>Checkpoints</th><th>Review</th></tr></thead><tbody>
          ${report.runs.map((row) => `<tr><td>${label(row.mode)}</td><td>${label(row.status)}</td><td>${row.reported_tokens} / ${row.budget_tokens}</td><td>${row.checkpoints}</td><td>${label(row.review_status)}</td></tr>`).join("")}
          </tbody></table></div><p>Observational pilot. No formal proofs certified.</p><ul>${report.limitations.map((note) => `<li>${h(note)}</li>`).join("")}</ul>`;
      } else if (button.dataset.pilotAction === "download") {
        const { fetchArtifactFile } = await import("./store.js");
        const file = await fetchArtifactFile(`/api/artifacts/${encodeURIComponent(button.dataset.id)}/file`);
        const objectUrl = URL.createObjectURL(file.blob);
        const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = file.fileName || "artifact"; anchor.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl),1000);
      }
    } catch (error) { container.querySelector(":scope > .pilot-error").textContent = error.message; }
  });
  try { await refresh(); } catch (error) { container.innerHTML = `<p role="alert">${h(error.message)}</p><a href="#/research">Back to research</a>`; }
}
