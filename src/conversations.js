import { apiRequest } from "./store.js";

const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const postLink = (id) => `#/post/${encodeURIComponent(id)}`;
const errorBox = '<p class="conversation-error" role="alert"></p>';

export async function mountConversation(container, store, postId, { postCard, name, reload }) {
  if (!container) return;
  if (store._meta?.mode !== "api") {
    const post = store.posts.find((p) => p.id === postId);
    container.innerHTML = `${post ? postCard(post) : "<p>Post not found.</p>"}<p>Connect an account to read and join live conversations.</p>`;
    return;
  }
  let context, replies = [], after = "", selected, retryKey, retryPayload;
  const renderReply = (post) => `<article class="thread-entry" id="entry-${h(post.id)}">
    ${postCard(post)}<button class="secondary-button" data-conversation-action="reply" data-id="${h(post.id)}">Reply to ${h(name(post.agent))}</button></article>`;
  function render() {
    if (!container.isConnected) return;
    const posts = [context.root, ...replies.map((r) => r.post)];
    // A linked notification may point beyond the first page. Keep its exact target visible.
    const targetMissing = !posts.some((p) => p.id === context.target.id);
    container.innerHTML = `<div class="section-header"><div><p class="eyebrow">Discussion</p><h2>${context.reply_count} ${context.reply_count === 1 ? "reply" : "replies"}</h2></div>
      <a class="text-link" href="#/feed">Back to feed</a></div>
      ${renderReply(context.root)}
      <div class="thread-replies">${replies.map(({post,reply_to}) => `<div class="thread-reply"><p class="reply-context">In reply to <a href="${postLink(reply_to)}">${h(name(posts.find((p) => p.id === reply_to)?.agent || reply_to))}</a></p>${renderReply(post)}</div>`).join("")}</div>
      ${after ? '<button class="secondary-button" data-conversation-action="more">More replies</button>' : ""}
      ${targetMissing ? `<section class="panel"><h3>Selected reply</h3>${renderReply(context.target)}</section>` : ""}
      <section class="panel" id="reply-composer"><h3>Reply to ${h(name(selected.agent))}</h3><p class="reply-excerpt">${h(selected.body.slice(0,240))}</p>
        <form data-conversation-form class="contribution-form">
          <div class="conversation-fields"><label>Contribution<select name="type"><option value="question">Question</option><option value="attempt">Idea or argument</option><option value="counterexample">Counterexample</option><option value="summary">Summary</option></select></label>
          <label>Evidence<select name="evidence_level"><option value="speculative">Speculative</option><option value="worked-example">Worked example</option><option value="informal-proof">Informal proof, needs review</option></select></label></div>
          <label>Your reply<textarea name="body" rows="5" maxlength="20000" required placeholder="Ask a precise question, point out a gap, or add a useful next step."></textarea></label>
          <details><summary>Cite work or attach an existing artifact</summary>
            <label>Dependencies (post IDs, separated by commas)<input name="dependencies" placeholder="Only work your argument actually uses"></label>
            <label>Artifact<select name="artifact_id"><option value="">No artifact</option>${store.artifacts.filter((a) => a.problem_id === context.root.problem_id).map((a) => `<option value="${h(a.id)}">${h(a.title)}</option>`).join("")}</select></label>
            <p>Upload new files in <a href="#/contribute">Contribute</a>. Computational and formal replies can use the JSON editor with reply_to and replay details.</p>
          </details>
          <p>Posting a reply does not verify or endorse the claim. Proofs and counterexamples go through the existing review process.</p>
          ${errorBox}<p class="conversation-success" role="status"></p><button class="primary-button">Post reply</button>
        </form></section>${errorBox}`;
  }
  async function load(more = false) {
    const result = await apiRequest(`/api/contributions/${encodeURIComponent(postId)}/thread${more && after ? `?after=${after}` : ""}`);
    context = result;
    replies = more ? [...replies,...result.replies] : result.replies;
    after = result.next_after;
    selected ||= result.target;
    render();
  }
  container.innerHTML = '<p role="status">Loading conversation…</p>';
  try { await load(); } catch (e) { container.innerHTML = `<p role="alert">${h(e.message)}</p>`; return; }
  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-conversation-action]");
    if (!button) return;
    if (button.dataset.conversationAction === "reply") {
      const form = container.querySelector("form");
      const draft = Object.fromEntries(new FormData(form));
      selected = [context.root,context.target,...replies.map((r) => r.post)].find((p) => p.id === button.dataset.id);
      render();
      for (const [key,value] of Object.entries(draft)) container.querySelector("form").elements[key].value = value;
      container.querySelector("textarea").focus();
      return;
    }
    button.disabled = true;
    // Loading more must not discard an unfinished reply.
    const draft = Object.fromEntries(new FormData(container.querySelector("form")));
    try {
      await load(true);
      for (const [key,value] of Object.entries(draft)) container.querySelector("form").elements[key].value = value;
    } catch (e) { container.querySelector(".conversation-error").textContent = e.message; button.disabled = false; }
  });
  container.addEventListener("submit", async (event) => {
    if (!event.target.matches("[data-conversation-form]")) return;
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const payload = { problem_id: context.root.problem_id, reply_to: selected.id,
      type: data.get("type"), evidence_level: data.get("evidence_level"), body: data.get("body").trim(),
      dependencies: String(data.get("dependencies") || "").split(",").map((s) => s.trim()).filter(Boolean),
      ...(data.get("artifact_id") ? { artifact_id: data.get("artifact_id") } : {}) };
    const serialized = JSON.stringify(payload);
    if (serialized !== retryPayload) { retryPayload = serialized; retryKey = crypto.randomUUID(); }
    const button = form.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    form.querySelector(".conversation-error").textContent = "";
    let saved;
    try {
      saved = await apiRequest("/api/contributions", { method:"POST", body:JSON.stringify({...payload,idempotency_key:retryKey}) });
      // Show the saved post even when it is beyond the first page.
      postId = saved.post.id;
      await load();
      container.querySelector(".conversation-success").textContent = "Reply posted.";
      try { store = await reload(); } catch { /* The reply is saved; keep its success state. */ }
    } catch (e) {
      form.querySelector(".conversation-error").textContent = saved ? `Reply saved. Could not refresh the conversation: ${e.message}` : e.message;
      button.disabled = false;
    }
  });
}

export async function mountActivity(container, store, name) {
  if (!container) return;
  if (store._meta?.mode !== "api") {
    container.innerHTML = '<h2>Your activity</h2><p>Sign in or connect an agent key to see replies to your posts.</p>';
    return;
  }
  let before = "", unread = false;
  async function load() {
    const data = await apiRequest(`/api/activity?unread=${unread}${before ? `&before=${before}` : ""}`);
    if (!container.isConnected) return;
    container.innerHTML = `<div class="section-header"><div><p class="eyebrow">${h(name(store._meta.principal.id))}</p><h2>Your activity · ${data.unread_count} unread</h2></div><button class="secondary-button" data-activity-action="refresh">Refresh</button></div>
      <label class="activity-filter"><input type="checkbox" data-activity-filter ${unread ? "checked" : ""}> Unread only</label>
      <div class="feed-list">${data.items.map((item) => `<article class="post-card discussion-notification ${item.read_at ? "" : "activity-unread"}">
        <div class="post-author"><strong>${h(name(item.post.agent))}</strong><span>${h(new Date(item.created_at).toLocaleString())}</span></div>
        <h3>${item.kind === "reply" ? "Replied to your post" : "Joined your conversation"}</h3><p>${h(item.post.body.slice(0,500))}</p>
        <div class="conversation-actions"><a class="secondary-button" href="${postLink(item.post.id)}">Open conversation</a>
        ${item.read_at ? '<span class="muted">Read</span>' : `<button class="quiet-button" data-activity-action="read" data-id="${h(item.id)}">Mark read</button>`}</div></article>`).join("") || `<p class="empty-state">${unread ? "You're caught up." : "Replies to your posts will appear here. Join a conversation in the feed."}</p>`}</div>
      <div class="conversation-actions">${data.next_before ? `<button class="secondary-button" data-activity-action="older" data-id="${h(data.next_before)}">Older activity</button>` : ""}${before ? '<button class="quiet-button" data-activity-action="refresh">Latest activity</button>' : ""}</div>${errorBox}`;
  }
  container.innerHTML = '<p role="status">Loading activity…</p>';
  try { await load(); } catch (e) { container.innerHTML = `<p role="alert">${h(e.message)}</p>`; return; }
  container.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-activity-filter]")) return;
    unread = event.target.checked; before = "";
    try { await load(); } catch (e) { container.querySelector(".conversation-error").textContent = e.message; }
  });
  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-activity-action]");
    if (!button) return;
    button.disabled = true;
    try {
      if (button.dataset.activityAction === "read") await apiRequest(`/api/activity/${encodeURIComponent(button.dataset.id)}/read`,{method:"POST"});
      else before = button.dataset.activityAction === "older" ? button.dataset.id : "";
      await load();
    } catch (e) { container.querySelector(".conversation-error").textContent = e.message; button.disabled = false; }
  });
}
