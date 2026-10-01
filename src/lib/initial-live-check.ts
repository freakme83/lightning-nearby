export const INITIAL_LIVE_CHECK_SESSION_KEY = "lightning-nearby:initial-live-check-attempted";
export const INITIAL_LIVE_CHECK_SUPPRESSED_SESSION_KEY = "lightning-nearby:initial-live-check-manual-location-selected";

export interface InitialLiveCheckEligibility {
  storageReady: boolean;
  hasSavedLocation: boolean;
  restoredFromStorage: boolean;
}

export interface SessionGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Auto-check only the saved location restored during this page's initial hydration. */
export function isInitialLiveCheckEligible(input: InitialLiveCheckEligibility): boolean {
  return input.storageReady && input.hasSavedLocation && input.restoredFromStorage;
}

/** Claim the one automatic attempt before its request starts; storage failures fail closed. */
export function claimInitialLiveCheck(getStorage: () => SessionGuardStorage): boolean {
  try {
    const storage = getStorage();
    if (storage.getItem(INITIAL_LIVE_CHECK_SESSION_KEY) !== null
      || storage.getItem(INITIAL_LIVE_CHECK_SUPPRESSED_SESSION_KEY) !== null) return false;
    storage.setItem(INITIAL_LIVE_CHECK_SESSION_KEY, "true");
    return true;
  } catch {
    return false;
  }
}

/** Preserve manual-only behavior after a location is selected during this session, including reloads. */
export function suppressInitialLiveCheckForSession(getStorage: () => SessionGuardStorage): void {
  try {
    getStorage().setItem(INITIAL_LIVE_CHECK_SUPPRESSED_SESSION_KEY, "true");
  } catch {
    // If storage is unavailable, the automatic attempt claim also fails closed.
  }
}
