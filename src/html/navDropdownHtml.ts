import { navItems } from "./components";


export function navDropdownHtml(currentPath: string): string {
    const linksHtml = navItems
        .map((item) => {
            const isActive = item.href === "/"
                ? currentPath === "/"
                : currentPath.startsWith(item.href);
            return `<a href="${item.href}" hx-get="${item.href}" hx-target="body" hx-push-url="true" class="${isActive ? "active" : ""}">${item.label}</a>`;
        })
        .join("\n    ");

    return `<div class="nav-dropdown">
    <button type="button" class="nav-dropdown-toggle" aria-label="Menu" aria-haspopup="true" aria-expanded="false" onclick="this.closest('.nav-dropdown').classList.toggle('open');this.setAttribute('aria-expanded', this.closest('.nav-dropdown').classList.contains('open'))">
      <span class="hamburger-icon">
        <span></span>
        <span></span>
        <span></span>
      </span>
    </button>
    <nav class="nav-dropdown-menu" role="menu">
      ${linksHtml}
    </nav>
  </div>`;
}
