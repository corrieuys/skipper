import type { Conversation } from "../conversations/manager";
import { escapeHtml } from "./components";

export function conversationListFragment(conversations: Conversation[], activeId?: string): string {
  const items = conversations.length === 0
    ? `<p class="muted" style="padding:0.5rem 0.75rem;font-size:0.78rem;">No conversations yet.</p>`
    : conversations
        .map((conv) => {
          const isActive = conv.id === activeId;
          const eid = escapeHtml(conv.id);
          const dot = conv.status === "active"
            ? `<span class="conv-status-dot conv-status-active"></span>`
            : `<span class="conv-status-dot conv-status-archived"></span>`;
          return `<div class="conversation-item${isActive ? " active" : ""}"
            hx-get="/fragments/chat/${eid}"
            hx-target="#dashboard-chat-panel"
            hx-swap="innerHTML">
            ${dot}
            <span class="conv-item-title">${escapeHtml(conv.title)}</span>
            <span class="conv-item-actions" onclick="event.stopPropagation();">
              <button class="conv-action-btn" title="Rename"
                onclick="event.stopPropagation();var t=prompt('Rename conversation:','${escapeHtml(conv.title).replace(/'/g, "\\'")}');if(t){htmx.ajax('POST','/api/conversations/${eid}/rename',{values:{title:t},swap:'none'}).then(function(){htmx.ajax('GET','/fragments/dashboard/chat',{target:'#dashboard-chat-panel',swap:'innerHTML'});});}">&#x270E;</button>
              <button class="conv-action-btn conv-action-btn--danger" title="Delete"
                onclick="event.stopPropagation();if(confirm('Delete this conversation?')){htmx.ajax('DELETE','/api/conversations/${eid}',{swap:'none'}).then(function(){htmx.ajax('GET','/fragments/dashboard/chat',{target:'#dashboard-chat-panel',swap:'innerHTML'});});}">&#x2715;</button>
            </span>
          </div>`;
        })
        .join("");

  return `<div class="conversation-list" id="conversation-list">
    <div style="padding:0.5rem 0.75rem;border-bottom:1px solid rgba(173,170,170,0.08);">
      <button class="btn-sm" style="width:100%;"
        hx-post="/fragments/conversations"
        hx-target="#dashboard-chat-panel"
        hx-swap="innerHTML">+ New Chat</button>
    </div>
    ${items}
  </div>`;
}
