/**
 * game.js
 * =======
 * Entry point. Creates the GameManager and drives the main game loop.
 *
 * Responsibilities:
 *   - Wait for DOMContentLoaded
 *   - Size the canvas to the container (logical pixels, no device-pixel ratio scaling)
 *   - Listen for resize / orientation-change and re-layout accordingly
 *   - Run the requestAnimationFrame loop, capping dt to 50ms (max 20 fps floor)
 *     so a tab-switch or laggy frame can't cause physics explosions
 *
 * This file contains NO game logic. All game state lives in GameManager.
 *
 * Connects to:
 *   - gameManager.js — instantiated here; onResize(), update(dt), render()
 *                      called each frame.
 *   - index.html     — #game-container and #gameCanvas element IDs.
 */

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('game-container');
  const canvas    = document.getElementById('gameCanvas');
  const ctx       = canvas.getContext('2d');

  /** @type {GameManager} */
  const gm = new GameManager(canvas, ctx);

  // ---------------------------------------------------------------------------
  // Canvas Sizing
  // ---------------------------------------------------------------------------

  /**
   * Resizes the canvas to fill the container, then notifies GameManager.
   * Called on load and on every resize/orientationchange event.
   */
  function resize() {
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
    gm.onResize(canvas.width, canvas.height);
  }

  window.addEventListener('resize',            resize);
  window.addEventListener('orientationchange', resize);
  resize(); // initial layout

  // ---------------------------------------------------------------------------
  // Game Loop
  // ---------------------------------------------------------------------------

  let lastTs = 0;

  /**
   * Main animation loop.
   * @param {number} ts - DOMHighResTimeStamp from requestAnimationFrame
   */
  function loop(ts) {
    // Cap dt to 50ms so a tab-switch or debug breakpoint doesn't send the
    // player through a wall or orbit the planet.
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs   = ts;

    gm.update(dt);
    gm.render();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(ts => {
    lastTs = ts;
    requestAnimationFrame(loop);
  });
});
