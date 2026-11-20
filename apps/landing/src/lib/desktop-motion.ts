// Used by both the React landing page and its standalone HTML export.
export function startDesktopMotion(root: HTMLElement) {
  const glyphs = "ABCDEFGHJKMNPQRSTUVWXYZ0123456789#$%+=?";
  const timers = new Map<Element, number>();
  const events = new AbortController();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  function settle(label: Element) {
    window.clearTimeout(timers.get(label));
    timers.delete(label);
    label
      .querySelectorAll("[data-glyph]")
      .forEach((cell) => cell.removeAttribute("data-glyph"));
  }

  function reveal(label: Element, delay = 0) {
    settle(label);
    const cells = Array.from(
      label.querySelectorAll<HTMLElement>(".decrypt-letter"),
    );
    let frame = 0;
    function tick() {
      if (
        root.dataset["motionPaused"] === "true" ||
        reducedMotion?.matches ||
        frame >= 14
      ) {
        settle(label);
        return;
      }
      const resolved = Math.floor((cells.length * Math.max(0, frame - 2)) / 12);
      cells.forEach((cell, index) => {
        if (index < resolved) cell.removeAttribute("data-glyph");
        else
          cell.dataset["glyph"] = glyphs.charAt(
            Math.floor(Math.random() * glyphs.length),
          );
      });
      frame++;
      timers.set(label, window.setTimeout(tick, 48));
    }
    timers.set(label, window.setTimeout(tick, delay));
  }

  const rules = root.querySelector(".rules-window");
  const flow = root.querySelector(".withdrawal-flow");
  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const { target, isIntersecting } of entries) {
              target.toggleAttribute("data-in-view", isIntersecting);
              if (target === rules && isIntersecting) {
                target
                  .querySelectorAll(".rule")
                  .forEach((rule, index) => reveal(rule, 140 * index));
              }
            }
          },
          { threshold: 0.25 },
        );
  if (flow) {
    if (observer) observer.observe(flow);
    else flow.setAttribute("data-in-view", "");
  }
  if (rules) observer?.observe(rules);

  root.querySelectorAll(".tier-row, .rule").forEach((row) => {
    row.addEventListener(
      "pointerenter",
      (event) => {
        if ((event as PointerEvent).pointerType !== "touch") reveal(row);
      },
      { signal: events.signal },
    );
    row.addEventListener("pointerleave", () => settle(row), {
      signal: events.signal,
    });
  });
  return () => {
    events.abort();
    observer?.disconnect();
    for (const row of timers.keys()) settle(row);
  };
}
