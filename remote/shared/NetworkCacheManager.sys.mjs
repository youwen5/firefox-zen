/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowsingContextListener:
    "chrome://remote/content/shared/listeners/BrowsingContextListener.sys.mjs",
  error: "chrome://remote/content/shared/webdriver/Errors.sys.mjs",
  TabManager: "chrome://remote/content/shared/TabManager.sys.mjs",
});

/**
 * Enum of possible network cache behaviors.
 *
 * @readonly
 * @enum {CacheBehavior}
 */
export const CacheBehavior = {
  Default: "default",
  Bypass: "bypass",
};

/**
 * The NetworkCacheManager is responsible for managing the cache status (enabling/disabling cache)
 * for navigables. It's meant to be a singleton, and the consumers can use the exported
 * methods to change the cache status or perform the state cleanup.
 *
 * @class NetworkCacheManager
 */
class NetworkCacheManager {
  #contextListener;
  #defaultCacheBehavior;
  #navigableCacheBehaviorMap;

  constructor() {
    this.#contextListener = new lazy.BrowsingContextListener();
    this.#contextListener.on("attached", this.#onContextAttached);

    this.#defaultCacheBehavior = CacheBehavior.Default;
    // WeakMap from navigables to cache behavior settings (CacheBehavior).
    this.#navigableCacheBehaviorMap = new WeakMap();
  }

  destroy() {
    this.#contextListener.off("attached", this.#onContextAttached);
    this.#contextListener.destroy();

    this.cleanup();
  }

  #getLoadFlags(behavior) {
    return behavior === CacheBehavior.Bypass
      ? Ci.nsIRequest.LOAD_BYPASS_CACHE
      : Ci.nsIRequest.LOAD_NORMAL;
  }

  #getWeakMapSize(weakMap) {
    return ChromeUtils.nondeterministicGetWeakMapKeys(weakMap).length;
  }

  #onContextAttached = (eventName, data = {}) => {
    if (this.#defaultCacheBehavior === CacheBehavior.Bypass) {
      this.#setLoadFlagsForBrowsingContext(
        data.browsingContext,
        this.#getLoadFlags(CacheBehavior.Bypass)
      );
    }
  };

  #setDefaultCacheBehavior(behavior) {
    if (this.#defaultCacheBehavior === behavior) {
      return;
    }

    this.#defaultCacheBehavior = behavior;
    this.#navigableCacheBehaviorMap = new WeakMap();

    const loadFlags = this.#getLoadFlags(behavior);

    // Update cache settings for all existing navigables.
    for (const browser of lazy.TabManager.browsers) {
      this.#setLoadFlagsForBrowsingContext(browser.browsingContext, loadFlags);
    }

    // In case the cache is globally disabled we have to listen to all
    // newly attached contexts and disable cache for them.
    if (this.#defaultCacheBehavior === CacheBehavior.Bypass) {
      this.#contextListener.startListening();
    } else {
      this.#contextListener.stopListening();
    }
  }

  #setLoadFlagsForBrowsingContext(browsingContext, loadFlags) {
    if (browsingContext.defaultLoadFlags !== loadFlags) {
      browsingContext.defaultLoadFlags = loadFlags;
    }
  }

  /**
   * Reset network cache bypassing logic.
   */
  cleanup() {
    this.#setDefaultCacheBehavior(CacheBehavior.Default);

    if (this.#getWeakMapSize(this.#navigableCacheBehaviorMap) === 0) {
      return;
    }

    const loadFlags = this.#getLoadFlags(CacheBehavior.Default);

    for (const browser of lazy.TabManager.browsers) {
      if (this.#navigableCacheBehaviorMap.has(browser.browsingContext)) {
        this.#setLoadFlagsForBrowsingContext(
          browser.browsingContext,
          loadFlags
        );
      }
    }

    this.#navigableCacheBehaviorMap = new WeakMap();
  }

  /**
   * Set network cache bypassing logic to a provided value
   * and optionally specified contexts.
   *
   * @param {CacheBehavior} behavior
   *     An enum value to set the network cache behavior.
   * @param {Array<BrowsingContext>=} contexts
   *     The list of browsing contexts where the network cache
   *     should be bypassed.
   *
   * @throws {UnsupportedOperationError}
   *     If unsupported configuration is passed.
   */
  updateCacheBehavior(behavior, contexts = null) {
    if (contexts === null) {
      // TODO: Bug 1905307. Add support for such case.
      if (this.#getWeakMapSize(this.#navigableCacheBehaviorMap) > 0) {
        throw new lazy.error.UnsupportedOperationError(
          "Updating the cache behavior globally when the cache behavior" +
            " is already set for individual contexts is not supported yet"
        );
      }

      this.#setDefaultCacheBehavior(behavior);
      this.#navigableCacheBehaviorMap = new WeakMap();
      return;
    }

    // TODO: Bug 1905307. Add support for such case.
    if (this.#defaultCacheBehavior === CacheBehavior.Bypass) {
      throw new lazy.error.UnsupportedOperationError(
        "Updating the cache behavior for individual contexts when it's" +
          " already set globally is not supported yet"
      );
    }

    const loadFlags = this.#getLoadFlags(behavior);

    for (const context of contexts) {
      if (this.#navigableCacheBehaviorMap.get(context) === behavior) {
        continue;
      }

      this.#setLoadFlagsForBrowsingContext(context, loadFlags);

      if (behavior === CacheBehavior.Default) {
        this.#navigableCacheBehaviorMap.delete(context);
      } else {
        this.#navigableCacheBehaviorMap.set(context, behavior);
      }
    }
  }
}

// Create a private NetworkCacheManager singleton.
const networkCacheManager = new NetworkCacheManager();

export function updateCacheBehavior(behavior, contexts) {
  return networkCacheManager.updateCacheBehavior(behavior, contexts);
}

export function cleanupCacheBypassState() {
  return networkCacheManager.cleanup();
}
