/**
 * input.js
 * ========
 * Captures keyboard and touch/swipe input and emits named events.
 * GameManager subscribes via .on(eventName, callback).
 *
 * Swipe detection:
 *   - Minimum swipe distance: 28px
 *   - Angle ±45° from cardinal direction to determine axis
 *   - Touch start/end used (not touchmove) to avoid scroll interference
 *
 * Keyboard:
 *   ArrowLeft / A  → onSwipeLeft
 *   ArrowRight / D → onSwipeRight
 *   ArrowUp / W / Space → onSwipeUp (jump)
 *   ArrowDown / S → onSwipeDown (slide)
 *   Enter / Space  → onTap (start/restart when idle)
 *
 * Connects to:
 *   - gameManager.js — calls .on() to register handlers; checks this.overlayOpen
 *     before acting on input events.
 */

class InputManager {
  /**
   * @param {HTMLElement} element - The element to listen for touch events on
   *                                (typically the canvas).
   */
  constructor(element) {
    this._el = element;
    this._handlers = {
      onSwipeLeft:  null,
      onSwipeRight: null,
      onSwipeUp:    null,
      onSwipeDown:  null,
      onTap:        null,
    };

    this._touchStartX = 0;
    this._touchStartY = 0;

    /** Minimum pixel distance for a touch movement to count as a swipe */
    this.MIN_SWIPE_DIST = 28;

    this._bindTouch();
    this._bindKeyboard();
  }

  // ---------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------

  /**
   * Registers a handler for a named input event.
   * @param {string}   event    - One of the keys in this._handlers
   * @param {Function} callback - Called with no arguments when event fires
   */
  on(event, callback) {
    if (event in this._handlers) {
      this._handlers[event] = callback;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Touch
  // ---------------------------------------------------------------------------

  _bindTouch() {
    this._el.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this._touchStartX = t.clientX;
      this._touchStartY = t.clientY;
    }, { passive: false });

    this._el.addEventListener('touchend', e => {
      e.preventDefault();
      const t  = e.changedTouches[0];
      const dx = t.clientX - this._touchStartX;
      const dy = t.clientY - this._touchStartY;

      const dist  = Math.sqrt(dx * dx + dy * dy);
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      if (dist < this.MIN_SWIPE_DIST) {
        // Short movement = tap
        this._emit('onTap');
        return;
      }

      // Determine cardinal direction
      if (absDx > absDy) {
        this._emit(dx > 0 ? 'onSwipeRight' : 'onSwipeLeft');
      } else {
        this._emit(dy > 0 ? 'onSwipeDown' : 'onSwipeUp');
      }
    }, { passive: false });
  }

  // ---------------------------------------------------------------------------
  // Private — Keyboard
  // ---------------------------------------------------------------------------

  _bindKeyboard() {
    window.addEventListener('keydown', e => {
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          e.preventDefault();
          this._emit('onSwipeLeft');
          break;
        case 'ArrowRight':
        case 'KeyD':
          e.preventDefault();
          this._emit('onSwipeRight');
          break;
        case 'ArrowUp':
        case 'KeyW':
          e.preventDefault();
          this._emit('onSwipeUp');
          break;
        case 'ArrowDown':
        case 'KeyS':
          e.preventDefault();
          this._emit('onSwipeDown');
          break;
        case 'Space':
        case 'Enter':
          e.preventDefault();
          // Space also triggers jump when playing — GameManager decides context
          this._emit('onSwipeUp');
          this._emit('onTap');
          break;
        default:
          break;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Private — Emit
  // ---------------------------------------------------------------------------

  /**
   * Calls the registered handler for the given event, if any.
   * @param {string} event
   * @private
   */
  _emit(event) {
    if (this._handlers[event]) this._handlers[event]();
  }
}
