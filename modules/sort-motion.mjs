// Sine runs this module in browser chrome. Use Zen's public helper and bound
// every wait: its promise resolves on finish, but not when a native rebuild
// cancels an animation or detaches its target.
export const animateSortElement = async (win, node, frames, options, interrupted) => {
  let controls = [], timer;
  try {
    const previous = new Set(node.getAnimations());
    const helper = win.gZenUIManager?.elementAnimate;
    const finished = typeof helper === "function"
      ? helper.call(win.gZenUIManager, node, frames, options)
      : node.animate(frames, options).finished;
    controls = node.getAnimations().filter(animation => !previous.has(animation));
    await Promise.race([
      Promise.resolve(finished).catch(() => {}),
      new Promise(resolve => { timer = win.setTimeout(resolve, (options.delay || 0) + options.duration + 120); }),
      ...(interrupted ? [interrupted] : []),
    ]);
  } catch { /* Presentation failure cannot change a completed native mutation. */ }
  finally {
    win.clearTimeout(timer);
    controls.forEach(animation => animation.cancel());
  }
};
