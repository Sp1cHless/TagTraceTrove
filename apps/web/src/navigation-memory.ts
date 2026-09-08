import { inject, type InjectionKey } from 'vue';

/**
 * Ephemeral navigation state for one mounted GalleryApp. Child pages are
 * intentionally remounted by the view ladder, so pagination and other view
 * state that must survive a detail drill-down lives here instead of in the
 * disposable child component instance.
 */
export interface NavigationMemory {
  pages: Map<string, number>;
  states: Map<string, unknown>;
}

export const navigationMemoryKey: InjectionKey<NavigationMemory> = Symbol('t3-navigation-memory');

export function createNavigationMemory(): NavigationMemory {
  return {
    pages: new Map(),
    states: new Map(),
  };
}

export function useNavigationMemory(): NavigationMemory {
  return inject(navigationMemoryKey, createNavigationMemory());
}
