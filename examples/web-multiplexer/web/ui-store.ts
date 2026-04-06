// examples/web-multiplexer/web/ui-store.ts
// MobX store for UI preferences (layout + filter state). Auto-persists to
// sessionStorage via a reaction.
//
// [LAW:one-source-of-truth] All persistent UI state lives here. Components
// read/write via the store, never touch sessionStorage directly.

import { makeAutoObservable, reaction } from "mobx";

const STORAGE_KEY = "tmux-demo-ui-v1";

interface PersistedShape {
  navbarWidth: number;
  asideCollapsed: boolean;
  hiddenEventTypes: string[];
  activeAsideTab: string;
}

const DEFAULTS: PersistedShape = {
  navbarWidth: 260,
  asideCollapsed: false,
  hiddenEventTypes: [],
  activeAsideTab: "debug",
};

function loadFromStorage(): PersistedShape {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    return {
      navbarWidth:
        typeof parsed.navbarWidth === "number" &&
        parsed.navbarWidth > 100 &&
        parsed.navbarWidth < 800
          ? parsed.navbarWidth
          : DEFAULTS.navbarWidth,
      asideCollapsed:
        typeof parsed.asideCollapsed === "boolean"
          ? parsed.asideCollapsed
          : DEFAULTS.asideCollapsed,
      hiddenEventTypes: Array.isArray(parsed.hiddenEventTypes)
        ? parsed.hiddenEventTypes.filter((x): x is string => typeof x === "string")
        : DEFAULTS.hiddenEventTypes,
      activeAsideTab:
        typeof parsed.activeAsideTab === "string"
          ? parsed.activeAsideTab
          : DEFAULTS.activeAsideTab,
    };
  } catch {
    return DEFAULTS;
  }
}

export class UiStore {
  navbarWidth: number;
  asideCollapsed: boolean;
  // Use a plain object instead of a Set for MobX observability ease + JSON.
  hiddenEventTypes: Record<string, true> = {};
  activeAsideTab: string;

  constructor() {
    const initial = loadFromStorage();
    this.navbarWidth = initial.navbarWidth;
    this.asideCollapsed = initial.asideCollapsed;
    this.activeAsideTab = initial.activeAsideTab;
    for (const t of initial.hiddenEventTypes) this.hiddenEventTypes[t] = true;

    makeAutoObservable(this);

    // Auto-persist on any observable change.
    reaction(
      () => ({
        navbarWidth: this.navbarWidth,
        asideCollapsed: this.asideCollapsed,
        hiddenEventTypes: Object.keys(this.hiddenEventTypes).sort(),
        activeAsideTab: this.activeAsideTab,
      }),
      (snapshot) => {
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        } catch {
          /* quota exceeded or private mode — ignore */
        }
      },
      { delay: 100 },
    );
  }

  setNavbarWidth(w: number): void {
    this.navbarWidth = Math.max(160, Math.min(800, Math.round(w)));
  }

  toggleAside(): void {
    this.asideCollapsed = !this.asideCollapsed;
  }

  toggleEventType(type: string): void {
    if (this.hiddenEventTypes[type] === true) {
      delete this.hiddenEventTypes[type];
    } else {
      this.hiddenEventTypes[type] = true;
    }
  }

  clearHidden(): void {
    this.hiddenEventTypes = {};
  }

  setActiveAsideTab(tab: string): void {
    this.activeAsideTab = tab;
  }

  isHidden(type: string): boolean {
    return this.hiddenEventTypes[type] === true;
  }
}
