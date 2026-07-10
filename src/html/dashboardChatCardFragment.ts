import type { Conversation, ConversationMessage } from "../conversations/manager";
import { escapeHtml } from "./components";
import { conversationListFragment } from "./conversationListFragment";
import { chatUserBubble, chatAssistantMessage } from "./chatPartFragment";
import { chatModePicker } from "./chatModePicker";

function renderMessage(msg: ConversationMessage): string {
  if (msg.role === "user") return chatUserBubble(msg.id, msg.content);
  if (msg.role === "assistant") return chatAssistantMessage(msg.id, msg.content, msg.parts);
  // system / fallback
  return `<div class="chat-message chat-message-system" data-message-id="${escapeHtml(msg.id)}"><div class="chat-message-content sk-md" data-artifact-md>${escapeHtml(msg.content)}</div></div>`;
}

export function dashboardChatCardFragment(
  conversation: Conversation | null,
  messages: ConversationMessage[],
  conversations: Conversation[],
  agentModel?: string,
  busy: boolean = false,
): string {
  const activeId = conversation?.id;
  const convList = conversationListFragment(conversations, activeId);

  const modelLabel = agentModel ? `<span style="font-size:0.65rem;color:var(--muted);font-family:var(--sk-font-mono,monospace);margin-left:0.5rem;">${escapeHtml(agentModel)}</span>` : "";
  const filterToggle = conversation
    ? `<label class="chat-filter-toggle" title="Hide tool_use and tool_result bubbles"><input type="checkbox" class="chat-filter-tool-calls" /><span>hide tools</span></label>`
    : "";
  const header = `<div class="cmd-panel-header">
    <span class="cmd-panel-title chat-conv-title">${conversation ? escapeHtml(conversation.title) : "Chat"}${modelLabel}</span>
    <div style="display:flex;gap:0.5rem;align-items:center;">
      ${conversation ? chatModePicker(conversation.id, conversation.permission_mode) : ""}
      ${filterToggle}
      ${conversation ? `<span class="badge ${conversation.status === "active" ? "badge-running" : "badge-stopped"}">${escapeHtml(conversation.status)}</span>` : ""}
      <button class="btn-sm" type="button" onclick="toggleChatFullscreen()" title="Fullscreen" style="padding:0.25rem 0.5rem;font-size:0.85rem;">&#x2922;</button>
    </div>
  </div>`;

  const sidebar = `<div class="chat-fullscreen-sidebar" id="chat-sidebar">
    <div class="cmd-panel-header">
      <span class="cmd-panel-title">Conversations</span>
    </div>
    ${convList}
  </div>`;

  if (!conversation) {
    return `${sidebar}
    <div class="chat-main">
      ${header}
      <div class="chat-empty-state">
        <p class="muted">No active conversation.</p>
        <button class="btn-sm"
          hx-post="/fragments/conversations"
          hx-target="#dashboard-chat-panel"
          hx-swap="innerHTML">Start a Conversation</button>
      </div>
    </div>`;
  }

  const convId = escapeHtml(conversation.id);
  const messagesHtml = messages.map(renderMessage).join("");

  return `${sidebar}
  <div class="chat-main">
    ${header}
    <div class="chat-messages" id="chat-messages-${convId}"${agentModel ? ` data-chat-model="${escapeHtml(agentModel)}"` : ""}>
      ${messagesHtml}
    </div>
    <div id="chat-busy-${convId}" class="chat-busy" data-busy="${busy ? "1" : "0"}">${busy ? `<div class="chat-busy__bubble"><span class="chat-busy__label">${agentModel ? escapeHtml(agentModel) : "skipper"}</span><span class="chat-typing-dots"><span></span><span></span><span></span></span></div>` : ""}</div>
    <div class="chat-input-area">
      <form hx-post="/api/conversations/${convId}/messages"
            hx-swap="none"
            hx-on::after-request="if(event.detail.successful){this.reset();var ta=this.querySelector('textarea');if(ta)ta.focus();}">
        <textarea name="content"
                  placeholder="Message Skipper... (Enter to send, Shift+Enter for newline)"
                  rows="2"
                  onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();var form=this.closest('form');if(form)htmx.trigger(form,'submit');}"></textarea>
        <div class="chat-input-row">
          <button type="button" class="btn-sm btn-secondary"
            onclick="if(confirm('Archive this conversation?')){htmx.ajax('DELETE','/api/conversations/${convId}',{swap:'none'}).then(function(){htmx.ajax('GET','/fragments/dashboard/chat',{target:'#dashboard-chat-panel',swap:'innerHTML'});})}"
            style="font-size:0.72rem;">Archive</button>
          <button type="submit">Send</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    (function() {
      var msgs = document.getElementById('chat-messages-${convId}');
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
