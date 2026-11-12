(function () {
  "use strict";

  const root = document.getElementById("self-steering-viz");
  if (!root) return;

  const COLORS = {
    page: "rgb(30,30,30)",
    text: "rgb(195,195,195)",
    dim: "rgba(195,195,195,0.55)",
    faint: "rgba(255,255,255,0.14)",
    box: "rgb(39,39,39)", // the MLP box; opaque, so it hides the tint behind
    stream: "rgb(105,105,105)",
    white: "#ffffff",
    condition: "#f6c344", // gate_proj: is the condition met?
    position: "#a1d5ff", // up_proj: is this a steered token position?
    write: "#7fcd62", // down_proj of neuron 1: the steering direction d
    cap: "#ff6b6b", // down_proj of neuron 2: the opposite write
    steer: "#ffffff", // the two writes summed, and the streams they steer
  };

  const CSS = `
.ssv { margin: 28px 0 36px; }
.ssv-scroll { overflow-x: auto; }
.ssv svg { display: block; width: 100%; min-width: 700px; height: auto; font-family: "Sarabun", sans-serif; }
.ssv svg text { white-space: pre; }
.ssv .ssv-math { font-family: "STIX Two Text", "Cambria", "Times New Roman", serif; font-style: italic; }
.ssv .ssv-mono { font-family: "Inconsolata", "Monaco", Courier, monospace; }
.ssv figcaption { font-size: 0.85em; color: rgba(195,195,195,0.75); margin-top: 12px; line-height: 1.45; }
`;

  // ---------------------------------------------------------------- helpers
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs, parent, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  // Text label. Labels with the math class are set like inline math: letters
  // italic, everything else upright, "_g" as a subscript, and "{SiLU}" as
  // upright text. Other labels are plain text.
  function label(parent, x, y, str, attrs) {
    const text = svgEl(
      "text",
      { x, y, fill: COLORS.text, "font-size": 11.5, ...attrs },
      parent,
    );
    if (!attrs || attrs.class !== MATH.class) {
      text.textContent = str;
      return text;
    }
    let lowered = false;

    for (const part of str.split(/(_\w|\{[^}]*\}|[^A-Za-z_{}]+)/)) {
      if (!part) continue;
      const span = {};
      let content = part;

      if (part[0] === "_") {
        content = part.slice(1);
        span["font-size"] = "72%";
        if (!lowered) span.dy = 3;
        lowered = true;
      } else {
        if (lowered) span.dy = -3;
        lowered = false;
        if (part[0] === "{") {
          content = part.slice(1, -1);
          span["font-style"] = "normal";
          span["font-family"] = '"Sarabun", sans-serif';
          span["font-size"] = "88%";
        } else if (!/[A-Za-z]/.test(part)) {
          span["font-style"] = "normal";
        }
      }
      svgEl("tspan", span, text, content);
    }
    return text;
  }

  const MATH = { class: "ssv-math", "font-size": 13.5 };
  const MONO = { class: "ssv-mono", "font-size": 9.5 };
  const TITLE = { fill: COLORS.white, "font-weight": 600, "font-size": 12.5 };

  function arrowhead(parent, from, to, fill) {
    const angle =
      (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
    svgEl(
      "path",
      {
        d: "M0,0 L-7,-3.5 L-7,3.5 Z",
        fill,
        transform: `translate(${to[0]},${to[1]}) rotate(${angle})`,
      },
      parent,
    );
  }

  // Wire through the given points, optionally ending in an arrowhead.
  function wire(parent, points, stroke, arrow, attrs) {
    svgEl(
      "polyline",
      {
        points: points.map((p) => p.join(",")).join(" "),
        fill: "none",
        stroke,
        "stroke-width": 1.5,
        "stroke-linejoin": "round",
        ...attrs,
      },
      parent,
    );
    if (arrow) arrowhead(parent, points.at(-2), points.at(-1), stroke);
  }

  // Circled operator on a wire: "+" adds, "x" multiplies.
  function operator(parent, x, y, kind, stroke) {
    svgEl(
      "circle",
      { cx: x, cy: y, r: 7, fill: COLORS.page, stroke, "stroke-width": 1.5 },
      parent,
    );
    const arms =
      kind === "+"
        ? [
            [4, 0],
            [0, 4],
          ]
        : [
            [3, 3],
            [3, -3],
          ];
    for (const [dx, dy] of arms) {
      wire(
        parent,
        [
          [x - dx, y - dy],
          [x + dx, y + dy],
        ],
        stroke,
        false,
        { "stroke-width": 1.3 },
      );
    }
  }

  function box(parent, x, y, width, height, stroke, attrs) {
    return svgEl(
      "rect",
      {
        x,
        y,
        width,
        height,
        rx: 4,
        fill: COLORS.page,
        stroke,
        "stroke-width": 1.2,
        ...attrs,
      },
      parent,
    );
  }

  function silu(x) {
    return x / (1 + Math.exp(-x));
  }

  // ----------------------------------------------------------------- layout
  const W = 760;
  const H = 428;
  // The example conversation, one chip per token. "user" and "assistant"
  // stand in for the role tokens of the chat template.
  const TOKENS = [
    "user",
    "What",
    "is",
    "the",
    "capital",
    "of",
    "Australia",
    "?",
    "I",
    "think",
    "it's",
    "Sydney",
    ".",
    "assistant",
    "The",
    "capital",
    "of",
    "Australia",
    "is",
    "Canberra",
    ".",
  ];
  const BELIEF = [8, 12]; // first and last token slot of the user's belief
  const STEERED = 13; // b is about 1 from the last prompt token onward
  const SHOWN = TOKENS.length - 1; // position whose MLP internals are drawn
  const TIP = 32; // arrowheads at the top of the residual streams
  const BOX_TOP = 84; // the MLP that holds the pair
  const BOX_BOT = 306;
  const ATTN_Y = 340; // where attention writes into the steered streams
  const CHIP_TOP = 374;
  const CHIP_H = 22;

  // Chips are as wide as their text needs (estimated from its length, so the
  // layout does not wait for the font) and are spread over the full width.
  const CHIPS = (() => {
    const left = 12;
    const right = 744;
    const widths = TOKENS.map((token) => Math.max(15, 9 + 5.3 * token.length));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const gap = (right - left - total) / (TOKENS.length - 1);
    let x = left;
    return widths.map((width) => {
      const chip = { x, width };
      x += width + gap;
      return chip;
    });
  })();
  const colX = (i) => CHIPS[i].x + CHIPS[i].width / 2;

  // ------------------------------------------- residual streams and tokens
  // One residual stream per token, flowing upward. Every stream passes
  // through the MLP box; only the one at SHOWN is drawn inside it (drawMlp).
  function drawStreams(svg) {
    const inBelief = (i) => i >= BELIEF[0] && i <= BELIEF[1];

    // Token positions where the up_proj read is on.
    svgEl(
      "rect",
      {
        x: CHIPS[STEERED].x - 3,
        y: TIP - 28,
        width: CHIPS[SHOWN].x + CHIPS[SHOWN].width + 6 - CHIPS[STEERED].x,
        height: CHIP_TOP + CHIP_H + 5 - (TIP - 28),
        rx: 6,
        fill: COLORS.position,
        opacity: 0.07,
      },
      svg,
    );

    TOKENS.forEach((token, i) => {
      const x = colX(i);
      const steered = i >= STEERED;

      if (i !== SHOWN) {
        // A steered stream changes colour where attention writes into it.
        const split = steered ? ATTN_Y : BOX_BOT;
        wire(
          svg,
          [
            [x, CHIP_TOP],
            [x, split],
          ],
          COLORS.stream,
        );
        if (steered) {
          wire(
            svg,
            [
              [x, split],
              [x, BOX_BOT],
            ],
            COLORS.condition,
          );
        }
        wire(
          svg,
          [
            [x, BOX_TOP],
            [x, TIP],
          ],
          steered ? COLORS.steer : COLORS.stream,
          true,
        );
      }

      const stroke = steered
        ? COLORS.white
        : inBelief(i)
          ? COLORS.condition
          : COLORS.stream;
      box(svg, CHIPS[i].x, CHIP_TOP, CHIPS[i].width, CHIP_H, stroke);
      label(svg, x, CHIP_TOP + 15, token, {
        "font-size": 10,
        "text-anchor": "middle",
        fill: COLORS.text,
      });
    });

    const brackets = [
      [1, BELIEF[0] - 1, "question", COLORS.dim],
      [BELIEF[0], BELIEF[1], "user belief", COLORS.condition],
      [STEERED, STEERED, "last prompt token", COLORS.white],
      [STEERED + 1, TOKENS.length - 1, "response", COLORS.white],
    ];
    for (const [from, to, name, color] of brackets) {
      const y = CHIP_TOP + CHIP_H + 8;
      const x1 = CHIPS[from].x + 1;
      const x2 = CHIPS[to].x + CHIPS[to].width - 1;
      wire(
        svg,
        [
          [x1, y - 3],
          [x1, y],
          [x2, y],
          [x2, y - 3],
        ],
        color,
        false,
        { "stroke-width": 1 },
      );
      label(svg, (x1 + x2) / 2, y + 14, name, {
        "font-size": 10.5,
        "text-anchor": "middle",
        fill: color,
      });
    }
  }

  // ----------------------------------------------- the MLP that holds the pair
  // The box hides the streams that pass behind it. The stream at SHOWN stays
  // visible, with the two neurons reading from it and writing back to it.
  function drawMlp(svg) {
    const streamX = colX(SHOWN);
    const busX = 24;
    const sumX = 474;
    const yOut = BOX_TOP + 30; // where the pair's output joins the stream
    const yTap = BOX_BOT - 14; // where the pair reads the stream
    const neurons = [
      {
        name: "Neuron 1",
        gateY: BOX_TOP + 62,
        gate: "w_g · x = a",
        down: "d",
        color: COLORS.write,
      },
      {
        name: "Neuron 2",
        gateY: BOX_TOP + 144,
        gate: "(w_g − c w_u) · x = a − cb",
        down: "−d",
        color: COLORS.cap,
      },
    ];

    svgEl(
      "rect",
      {
        x: 10,
        y: BOX_TOP,
        width: W - 20,
        height: BOX_BOT - BOX_TOP,
        rx: 8,
        fill: COLORS.box,
        stroke: COLORS.faint,
      },
      svg,
    );
    label(svg, 24, BOX_TOP + 20, "Layer ℓ MLP", TITLE);

    // The stream at SHOWN: it carries the belief from where attention writes
    // into it, is read at the tap, and is steered from the output upward.
    wire(
      svg,
      [
        [streamX, CHIP_TOP],
        [streamX, ATTN_Y],
      ],
      COLORS.stream,
    );
    wire(
      svg,
      [
        [streamX, ATTN_Y],
        [streamX, yOut],
      ],
      COLORS.condition,
    );
    wire(
      svg,
      [
        [streamX, yOut],
        [streamX, TIP],
      ],
      COLORS.steer,
      true,
    );
    svgEl(
      "circle",
      { cx: streamX, cy: yTap, r: 2.5, fill: COLORS.condition },
      svg,
    );
    wire(
      svg,
      [
        [streamX, yTap],
        [busX, yTap],
        [busX, neurons[0].gateY],
      ],
      COLORS.stream,
    );

    for (const n of neurons) {
      const upY = n.gateY + 32;
      const projections = [
        [n.gateY, "gate_proj", n.gate, COLORS.condition],
        [upY, "up_proj", "w_u · x = b", COLORS.position],
      ];

      label(svg, 34, n.gateY - 19, n.name, {
        fill: COLORS.white,
        "font-weight": 600,
        "font-size": 10.5,
      });

      for (const [y, name, math, color] of projections) {
        wire(
          svg,
          [
            [busX, y],
            [34, y],
          ],
          COLORS.stream,
          true,
        );
        box(svg, 34, y - 13, 210, 26, color);
        label(svg, 42, y + 3.5, name, { ...MONO, fill: color });
        label(svg, 104, y + 4.5, math, { ...MATH, fill: COLORS.white });
      }

      // gate -> SiLU -> multiplied by the up read -> scaled copy of +-d
      wire(
        svg,
        [
          [244, n.gateY],
          [262, n.gateY],
        ],
        COLORS.stream,
        true,
      );
      box(svg, 262, n.gateY - 11, 42, 22, COLORS.stream);
      label(svg, 283, n.gateY + 4, "SiLU", {
        "font-size": 11,
        "text-anchor": "middle",
      });
      wire(
        svg,
        [
          [304, n.gateY],
          [327, n.gateY],
        ],
        COLORS.stream,
        true,
      );
      wire(
        svg,
        [
          [244, upY],
          [334, upY],
          [334, n.gateY + 7],
        ],
        COLORS.stream,
        true,
      );
      operator(svg, 334, n.gateY, "x", COLORS.text);
      wire(
        svg,
        [
          [341, n.gateY],
          [360, n.gateY],
        ],
        COLORS.stream,
        true,
      );
      box(svg, 360, n.gateY - 13, 96, 26, n.color);
      label(svg, 368, n.gateY + 3.5, "down_proj", { ...MONO, fill: n.color });
      label(svg, 438, n.gateY + 4.5, n.down, {
        ...MATH,
        fill: COLORS.white,
        "text-anchor": "middle",
      });
      wire(
        svg,
        [
          [456, n.gateY],
          [sumX, n.gateY],
        ],
        n.color,
      );
    }

    // The two writes sum on their way to the residual stream.
    wire(
      svg,
      [
        [sumX, neurons[1].gateY],
        [sumX, neurons[0].gateY],
      ],
      COLORS.cap,
    );
    wire(
      svg,
      [
        [sumX, neurons[0].gateY],
        [sumX, yOut],
        [streamX - 7, yOut],
      ],
      COLORS.steer,
      true,
    );
    svgEl(
      "circle",
      { cx: sumX, cy: neurons[0].gateY, r: 2.5, fill: COLORS.steer },
      svg,
    );
    operator(svg, streamX, yOut, "+", COLORS.steer);
    label(
      svg,
      (sumX + streamX) / 2,
      yOut - 8,
      "αd, { } α = b ({SiLU}(a) − {SiLU}(a − cb))",
      { ...MATH, fill: COLORS.steer, "text-anchor": "middle" },
    );
  }

  // ---------------------------------------------- attention, earlier blocks
  // How the belief reaches the steered positions, in the notation used for
  // the pair: a dot reads a stream and a circled plus adds to one. Attention
  // only reads leftward, so the line runs from the belief tokens to the
  // positions after them. Individual heads and blocks are not drawn.
  function drawAttention(svg) {
    for (let i = BELIEF[0] + 1; i < TOKENS.length; i++) {
      const writes = i >= STEERED;
      wire(
        svg,
        [
          [colX(i - 1), ATTN_Y],
          [colX(i) - (writes ? 7 : 0), ATTN_Y],
        ],
        COLORS.condition,
        writes,
      );
    }
    for (let i = BELIEF[0]; i < TOKENS.length; i++) {
      if (i >= STEERED) {
        operator(svg, colX(i), ATTN_Y, "+", COLORS.condition);
      } else {
        svgEl(
          "circle",
          { cx: colX(i), cy: ATTN_Y, r: 2.5, fill: COLORS.condition },
          svg,
        );
      }
    }

    const lines = [
      ["user belief is captured at ", COLORS.condition],
      ["response tokens via attention", COLORS.condition],
      //   ["read the belief tokens' streams, add to later ones", COLORS.dim],
    ];
    lines.forEach(([str, fill], k) => {
      const text = label(svg, colX(BELIEF[0]) - 13, ATTN_Y - 4 + 14 * k, str, {
        "font-size": 10.5,
        "text-anchor": "end",
        fill,
      });
      // A halo in the page colour keeps the label legible over the streams.
      text.setAttribute("stroke", COLORS.page);
      text.setAttribute("stroke-width", 5);
      text.setAttribute("paint-order", "stroke");
    });
  }

  // How much of d the pair writes, as a function of the gate read a (b = 1).
  function drawSaturation(svg, left, top, width, height) {
    const c = 3;
    const aMin = -4;
    const aMax = 13;
    const vMax = 6; // well above c, to show that SiLU(a) keeps growing
    const px = (a) => left + ((a - aMin) / (aMax - aMin)) * width;
    const zero = top + height - 14; // the curve dips a little below zero
    const py = (v) => zero - (v / vMax) * (zero - top);

    function curve(f) {
      const points = [];
      for (let a = aMin; a <= aMax + 1e-9; a += 0.1) {
        const v = f(a);
        if (v > vMax) break;
        points.push([px(a).toFixed(1), py(v).toFixed(1)]);
      }
      return points;
    }

    wire(
      svg,
      [
        [left, top],
        [left, zero],
        [left + width, zero],
      ],
      COLORS.stream,
      false,
      { "stroke-width": 1 },
    );
    wire(
      svg,
      [
        [px(0), zero],
        [px(0), zero + 4],
      ],
      COLORS.stream,
      false,
      { "stroke-width": 1 },
    );
    label(svg, px(0), zero + 16, "0", {
      "font-size": 10.5,
      "text-anchor": "middle",
    });
    label(svg, left + width, zero + 16, "a", {
      ...MATH,
      "text-anchor": "end",
    });

    wire(
      svg,
      [
        [left, py(c)],
        [left + width, py(c)],
      ],
      COLORS.dim,
      false,
      { "stroke-width": 1, "stroke-dasharray": "2 3" },
    );
    label(svg, left - 5, py(c) + 4, "c", { ...MATH, "text-anchor": "end" });
    label(svg, left - 5, py(0) + 4, "0", {
      "font-size": 10.5,
      "text-anchor": "end",
    });

    // Neuron 1 alone, then both neurons, in the colours of their wires. Each
    // curve is labelled beside it: the first to the left of where it leaves
    // the plot, the second under its plateau.
    const FN = { ...MATH, "font-size": 12, "text-anchor": "end" };
    const aLabel = 6;

    wire(svg, curve(silu), COLORS.write);
    wire(
      svg,
      curve((a) => silu(a) - silu(a - c)),
      COLORS.steer,
      false,
      { "stroke-width": 2 },
    );
    label(svg, px(aLabel) - 10, py(silu(aLabel)) + 4, "{SiLU}(a)", {
      ...FN,
      fill: COLORS.write,
    });
    label(svg, left + width, py(c) + 18, "{SiLU}(a) − {SiLU}(a − c)", {
      ...FN,
      fill: COLORS.steer,
    });
  }

  // ------------------------------------------------------------------ build
  if (!document.getElementById("ssv-style")) {
    const style = document.createElement("style");
    style.id = "ssv-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  root.classList.add("ssv");

  const scroll = document.createElement("div");
  scroll.className = "ssv-scroll";
  root.prepend(scroll);

  const svg = svgEl(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label":
        "Schematic of the steering neuron pair: the residual streams of all " +
        "tokens pass through the MLP that holds the pair, which adds the " +
        "steering direction at the last prompt token and the response",
    },
    scroll,
  );

  drawStreams(svg);
  drawMlp(svg);
  drawAttention(svg);
  drawSaturation(svg, 522, BOX_TOP + 60, 190, 132);
})();
