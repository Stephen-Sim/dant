/** Browser lifecycle and mutation capabilities consumed by the floating call window. */
export interface OverlayLifecycleWindow {
  addEventListener(type: 'beforeunload', listener: () => void): void;
  removeEventListener(type: 'beforeunload', listener: () => void): void;
}
export interface OverlayMutationObserver {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}
export interface OverlayMutationObserverConstructor {
  new (callback: () => void): OverlayMutationObserver;
}
