import type { Conversation, ConversationMessage } from "../conversations/manager";
import { escapeHtml } from "./components";
import { conversationListFragment } from "./conversationListFragment";
import { chatUserBubble, chatAssistantMessage } from "./chatPartFragment";
import { chatModePicker } from "./chatModePicker";

function renderMessage(msg: ConversationMessage): string {
  if (msg.role === "user") return chatUserBubble(msg.id, msg.content);
  if (msg.role === "assistant") return chatAssistantMessage(msg.id, msg.content, msg.parts);
  return `<div class="chat-message chat-message-system" data-message-id="${escapeHtml(msg.id)}"><div class="chat-message-content sk-md" data-artifact-md>${escapeHtml(msg.content)}</div></div>`;
}

/**
 * Renders the inner content for fullscreen chat mode.
 * Loaded into #dashboard-chat-panel via the /fragments/chat/fullscreen/:id route.
 * The route handler adds JS to set the chat-fullscreen class.
 */
export function chatFullscreenView(
  conversations: Conversation[],
  activeId: string,
  messages: ConversationMessage[],
  agentModel?: string,
  busy: boolean = false,
): string {
  const conversation = conversations.find((c) => c.id === activeId) ?? null;
  const convList = conversationListFragment(conversations, activeId);
  const messagesHtml = messages.map(renderMessage).join("");
  const convId = conversation ? escapeHtml(conversation.id) : "";

  const mainContent = conversation
    ? `<div class="chat-messages" id="chat-messages-${convId}"${agentModel ? ` data-chat-model="${escapeHtml(agentModel)}"` : ""}>
        ${messagesHtml}
      </div>
      <div id="chat-busy-${convId}" class="chat-busy" data-busy="${busy ? "1" : "0"}">${busy ? `<div class="chat-busy__bubble"><span class="chat-busy__label">${agentModel ? escapeHtml(agentModel) : "skipper"}</span><span class="chat-typing-dots"><span></span><span></span><span></span></span></div>` : ""}</div>
      <div class="chat-input-area">
        <form hx-post="/api/conversations/${convId}/messages"
              hx-swap="none"
              hx-on::after-request="if(event.detail.successful){this.reset();var ta=this.querySelector('textarea');if(ta)ta.focus();}">
          <textarea name="content"
                    placeholder="Message Skipper... (Enter to send, Shift+Enter for newline)"
                    rows="3"
                    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();var form=this.closest('form');if(form)htmx.trigger(form,'submit');}"></textarea>
          <div class="chat-input-row">
            <button type="button" class="btn-sm btn-secondary"
              onclick="if(confirm('Archive this conversation?')){htmx.ajax('DELETE','/api/conversations/${convId}',{swap:'none'}).then(function(){htmx.ajax('GET','/fragments/dashboard/chat',{target:'#dashboard-chat-panel',swap:'innerHTML'}).then(function(){var p=document.getElementById('dashboard-chat-panel');if(p)p.classList.remove('chat-fullscreen');document.body.classList.remove('chat-fullscreen-active');document.body.style.overflow='';});})}"
              style="font-size:0.72rem;">Archive</button>
            <button type="submit">Send</button>
          </div>
        </form>
      </div>`
    : `<div class="chat-empty-state">
        <p class="muted">Select a conversation or start a new one.</p>
        <button class="btn-sm"
          hx-post="/fragments/conversations"
          hx-target="#dashboard-chat-panel"
          hx-swap="innerHTML"
          hx-on::after-request="var p=document.getElementById('dashboard-chat-panel');if(p){p.classList.add('chat-fullscreen');document.body.classList.add('chat-fullscreen-active');}">New Conversation</button>
      </div>`;

  return `<div class="chat-fullscreen-sidebar" id="chat-sidebar">
    <div class="cmd-panel-header">
      <span class="cmd-panel-title">Conversations</span>
    </div>
    ${convList}
  </div>
  <div class="chat-main">
    <div class="cmd-panel-header">
      <span class="cmd-panel-title">${conversation ? escapeHtml(conversation.title) : "Chat"}${agentModel ? `<span style="font-size:0.65rem;color:var(--muted);font-family:var(--sk-font-mono,monospace);margin-left:0.5rem;">${escapeHtml(agentModel)}</span>` : ""}</span>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        ${conversation ? chatModePicker(conversation.id, conversation.permission_mode) : ""}
        ${conversation ? `<label class="chat-filter-toggle" title="Hide tool_use and tool_result bubbles"><input type="checkbox" class="chat-filter-tool-calls" /><span>hide tools</span></label>` : ""}
        ${conversation ? `<span class="badge ${conversation.status === "active" ? "badge-running" : "badge-stopped"}">${escapeHtml(conversation.status)}</span>` : ""}
        <button class="btn-sm" type="button" onclick="toggleChatFullscreen()" title="Exit Fullscreen" style="padding:0.25rem 0.5rem;">&#x2715;</button>
      </div>
    </div>
    ${mainContent}
  </div>
  <script>
    (function() {
      var panel = document.getElementById('dashboard-chat-panel');
      if (panel) panel.classList.add('chat-fullscreen');
      document.body.classList.add('chat-fullscreen-active');
      document.body.style.overflow = 'hidden';
      var msgs = ${convId ? `document.getElementById('chat-messages-${convId}')` : "null"};
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      if (window.__chatScrollObserver) window.__chatScrollObserver.disconnect();
      window.__chatScrollObserver = new MutationObserver(function() {
        var el = document.querySelector('#dashboard-chat-panel .chat-messages');
        if (el) { var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atBottom) el.scrollTop = el.scrollHeight; }
      });
      if (msgs) window.__chatScrollObserver.observe(msgs, { childList: true, subtree: true });
      var slashTa = document.querySelector('#dashboard-chat-panel .chat-input-area textarea');
      if (slashTa && window.Skipper && window.Skipper.chat && window.Skipper.chat.initSlashAutocomplete) {
        window.Skipper.chat.initSlashAutocomplete(slashTa);
      }
    })();
  </script>`;
}
