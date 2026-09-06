/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    filter,
    fromEvent,
    interval,
    map,
    merge,
    scan,
    startWith,
    switchMap,
    take,
} from "rxjs";

/** 
 * Constants 
 * Config values grouped into 'as const' objects rather than loose
 * top-level constants, so each group reads as one cohesive unit (e.g.
 * every canvas dimension lives under 'Viewport') and every property is
 * frozen instead of a widened 'number'.
 */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Target = {
    WIDTH: 64,
    HEIGHT: 36,
} as const;

const Constants = {
    DIGIT_COUNT: 8,
    TICK_RATE_MS: 20, // for smooth animation
} as const;

// types
type Digit = 0 | 1;

type FallingTarget = Readonly<{
    value: number; // 0-15, the hex digit the player must match
    y: number; // current vertical position
}>;

// State processing
type State = Readonly<{
    digits: ReadonlyArray<Digit>; // 8-bit row, index 0 = MSB
    targets: ReadonlyArray<FallingTarget>;
    seed: number; // current RNG seed
    ticksSinceLastSpawn: number; // counts up each tick, resets on spawn
    ticksSurvived: number;
    score: number;
    isPaused: boolean;
    gameEnd: boolean;
}>;

const TargetConfig = {
    BASE_FALL_SPEED: 0.24,  // starting px per tick
    MAX_FALL_SPEED: 2,      // so it doesn't become unplayably fast
    SPEED_RAMP_TICKS: 3000, // ticks (≈30s at 20ms/tick) to reach max speed
    CHECK_LINE_Y: Viewport.CANVAS_HEIGHT - 60,
    SPAWN_Y: 20,
} as const;

/**
 * Builds a brand-new game state. Called once per session (see
 * 'gameSession$'), so every run starts from a fresh, deterministic-given-
 * its-seed snapshot rather than mutating some shared object.
 */
const makeInitialState = (): State => {
    const startSeed = Date.now();
    const firstValueSeed = RNG.hash(startSeed);
    return {
        digits: Array(Constants.DIGIT_COUNT).fill(0),
        targets: [
            {
                value: seedToTargetValue(RNG.scale(firstValueSeed)),
                y: TargetConfig.SPAWN_Y,
            },
        ],
        seed: firstValueSeed,
        ticksSinceLastSpawn: 0,
        ticksSurvived: 0,
        score: 0,
        isPaused: false,
        gameEnd: false,
    };
};

const MIN_SPAWN_DELAY_MS = 2000;
const MAX_SPAWN_DELAY_MS = 3000;

const MIN_SPAWN_DELAY_TICKS = Math.ceil(
    MIN_SPAWN_DELAY_MS / Constants.TICK_RATE_MS,
);

/** Maps a [0,1) scaled seed value to a random hex digit 0-15. Pure. */
const seedToTargetValue = (scaledSeed: number): number =>
    Math.floor(scaledSeed * 16);

/** Interprets the digit row as a single binary number, MSB first. Pure. */
const digitsToNumber = (digits: ReadonlyArray<Digit>): number =>
    digits.reduce<number>((acc, d) => acc * 2 + d, 0);

/** Fall speed increases linearly with survival time, capped at MAX_FALL_SPEED. Pure. */
const currentFallSpeed = (ticksSurvived: number): number => {
    const progress = Math.min(ticksSurvived / TargetConfig.SPEED_RAMP_TICKS, 1);
    return (
        TargetConfig.BASE_FALL_SPEED +
        progress * (TargetConfig.MAX_FALL_SPEED - TargetConfig.BASE_FALL_SPEED)
    );
};

/**
 * A pure, seedable pseudo-random number generator
 * Given the same seed, hash() always produces the same next
 * value, making randomness deterministic and testable rather than a
 * hidden side effect. Expressed as a plain object of functions (not a
 * class) since there is no instance state at all
 * every call takes a seed in and returns a value out, 
 * with nothing stored between calls.
 */
class RNG {
    // LCG constants
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    /** Computes the next seed from the current one. Pure function. */
    static hash(seed: number): number {
        return (RNG.a * seed + RNG.c) % RNG.m;
    }

    /** Scales a seed to a value in [0, 1). Pure function. */
    static scale(seed: number): number {
        return seed / (RNG.m - 1);
    }
}

/**
 * returns a new array with the element at 'index'
 * transformed by 'f', leaving every other element untouched. Works for any
 * element type 'T', so it covers both the digit row and the
 * target list without writing the same map-and-check logic twice.
 */
const updateAt =
    <T>(index: number, f: (item: T) => T) =>
    (xs: ReadonlyArray<T>): ReadonlyArray<T> =>
        xs.map((x, i) => (i === index ? f(x) : x));

/**
 * Minimal left-to-right function composition for unary functions.
 * Lets a pipeline of small State -> State stages read as a single
 * declarative expression instead of one large nested function body.
 */
const pipe2 =
    <A, B, C>(f: (a: A) => B, g: (b: B) => C) =>
    (a: A): C =>
        g(f(a));

/**
 * An action is any pure transformation the game can apply to its state
 * for a single event (a key press, a click, or a tick). Modelling it as
 * a plain function rather than a class with an 'apply' method means
 * actions are ordinary values: they can be built with partial application
 * passed around, and combined with 'pipe2'
 */
type Action = (s: State) => State;
 
/**
 * fixing 'index' first yields a reusable State -> State action.
 * Used identically by both the keyboard handler and the mouse handler
 * so the same partially-applied function backs two independent input streams.
 */
const flipDigit =
    (index: number) =>
    (s: State): State => ({
        ...s,
        digits: updateAt<Digit>(index, d => (1 - d) as Digit)(s.digits),
    });

/** Toggles the paused flag. Takes no configuration, so unlike 'flipDigit'
 * it is used directly as a value rather than called to produce one. */
const togglePause = (s: State): State => ({ ...s, isPaused: !s.isPaused });

/**
 * fixing 'speed' yields a reusable FallingTarget -> FallingTarget
 * transform that can be mapped over any list of targets.
 */
const moveTarget =
    (speed: number) =>
    (t: FallingTarget): FallingTarget => ({
        ...t,
        y: t.y + speed,
    });

/**
 * fixing 'threshold' used when deciding whether to spawn a new target.
 */
const rollBelow =
    (threshold: number) =>
    (roll: number): boolean =>
        roll < threshold;
 
/** Stage 1 of tick: move every target down by the current fall speed. */
const applyMovement = (s: State): State => ({
    ...s,
    targets: s.targets.map(moveTarget(currentFallSpeed(s.ticksSurvived))),
});

/**
 * Stage 2 of tick: resolve the lowest target against the player's current
 * digit row award a match, remove the matched target, or end the game
 * if it passed the check line unmatched.
 */
const resolveCollisions = (s: State): State => {
    const lowest = s.targets[0];
 
    const isMatch =
        lowest !== undefined && digitsToNumber(s.digits) === lowest.value;
 
    const isMissedAtLine =
        lowest !== undefined &&
        !isMatch &&
        lowest.y >= TargetConfig.CHECK_LINE_Y;
 
    return {
        ...s,
        targets: isMatch ? s.targets.slice(1) : s.targets,
        score: isMatch ? s.score + 1 : s.score,
        gameEnd: isMissedAtLine ? true : s.gameEnd,
    };
};

/**
 * Stage 3 of tick: possibly spawn a new falling target and advance the
 * survival/seed bookkeeping.
 *
 * Two independent, chained RNG rolls: one decides whether to spawn this
 * tick, a second decides what value the new target gets.
 */
const maybeSpawn = (s: State): State => {
    const spawnRollSeed = RNG.hash(s.seed);
    const spawnRoll = RNG.scale(spawnRollSeed);
    const spawnThresholdPerTick =
        Constants.TICK_RATE_MS /
        ((MIN_SPAWN_DELAY_MS + MAX_SPAWN_DELAY_MS) / 2);
 
    const ticksSinceLastSpawn = s.ticksSinceLastSpawn + 1;
    const pastMinGap = ticksSinceLastSpawn >= MIN_SPAWN_DELAY_TICKS;
    const readyToSpawn = pastMinGap && rollBelow(spawnThresholdPerTick)(spawnRoll);
 
    const valueRollSeed = RNG.hash(spawnRollSeed);
    const spawnedValue = seedToTargetValue(RNG.scale(valueRollSeed));
 
    const finalSeed = readyToSpawn ? valueRollSeed : spawnRollSeed;
 
    const targetsAfterSpawn = readyToSpawn
        ? [...s.targets, { value: spawnedValue, y: TargetConfig.SPAWN_Y }]
        : s.targets;
 
    return {
        ...s,
        targets: targetsAfterSpawn,
        seed: finalSeed,
        ticksSinceLastSpawn: readyToSpawn ? 0 : ticksSinceLastSpawn,
        ticksSurvived: s.ticksSurvived + 1,
    };
};

/**
 * The per-frame action
 * A no-op while paused or once the game has ended.
 */
const tick: Action = (s: State): State =>
    s.isPaused || s.gameEnd
        ? s
        : pipe2(pipe2(applyMovement, resolveCollisions), maybeSpawn)(s);
 
/**
 * The 'scan' accumulator. Now that every action is already a plain
 * State -> State function, the indirection is
 * kept so the intent ("apply the next action to the running state") reads
 * clearly at the 'scan' call site in 'gameSession$'.
 */
const reduceState = (s: State, action: Action): State => action(s);
 
// Each stream below maps a raw DOM event into an 'Action' value. None of
// them touch 'State; directly they only produce a function that
// later gets applied by 'reduceState' inside 'scan', keeping event
// handling and state transformation fully decoupled.

/** Digit keys 1-8 flip the corresponding bit in the digit row. */
const flip$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter(e => /^[1-8]$/.test(e.key)),
    map(e => flipDigit(Number(e.key) - 1)),
);

/** Drives the game loop: one 'tick' action per animation frame. */
const tick$ = interval(Constants.TICK_RATE_MS).pipe(map(() => tick));
 
const canvasElement = document.querySelector("#svgCanvas") as SVGSVGElement;

/**
 * Maps a mousedown event's screen coordinates into SVG viewBox space,
 * then determines which digit slot was clicked. Reuses the same
 * partially-applied 'flipDigit' action as the keyboard handler, so mouse
 * and keyboard input converge on identical logic.
 */
const digitClick$ = fromEvent<MouseEvent>(canvasElement, "mousedown").pipe(
    map(e => {
        const rect = canvasElement.getBoundingClientRect();
        const scaleX = Viewport.CANVAS_WIDTH / rect.width;
        const scaleY = Viewport.CANVAS_HEIGHT / rect.height;
        const svgX = (e.clientX - rect.left) * scaleX;
        const svgY = (e.clientY - rect.top) * scaleY;
        const digitWidth = Viewport.CANVAS_WIDTH / Constants.DIGIT_COUNT;
        const digitRowTop = Viewport.CANVAS_HEIGHT - 50;
        const digitRowBottom = digitRowTop + 40;
        const isInDigitRow = svgY >= digitRowTop && svgY <= digitRowBottom;
        const index = Math.floor(svgX / digitWidth);
        return isInDigitRow && index >= 0 && index < Constants.DIGIT_COUNT
            ? index
            : -1;
    }),
    filter(index => index !== -1),
    map(index => flipDigit(index)),
);

/**
 * Fires on 'r'/'R'. Carries no action of its own 
 * 'state$' below
 * 'switchMap's on this stream purely to restart a fresh 'gameSession$()'.
 */
const restartKey$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter(e => e.key === "r" || e.key === "R"),
);

/** 'p'/'P' toggles pause. */
const pauseKey$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter(e => e.key === "p" || e.key === "P"),
    map(() => togglePause))
;

/**
 * A single playthrough: merges every input action stream into one, and
 * folds them over the initial state with 'scan' to produce a live State
 * stream. A fresh call creates a fresh 'scan' accumulator, which is what
 * lets 'state$' implement "restart" by simply re-subscribing to a new
 * 'gameSession$()'.
 */
export const gameSession$ = (): Observable<State> =>
    merge(flip$, tick$, digitClick$, pauseKey$).pipe(
        scan(reduceState, makeInitialState()),
    );

/**
 * The externally-consumed state stream. Emits immediately (via
 * startWith) so the game begins without waiting for a keypress, and
 * 'switchMap's to a brand-new 'gameSession$()' every time 'restartKey$' fires 
 * cleanly unsubscribing the previous session's 'scan' state.
 */
export const state$ = (): Observable<State> =>
    merge(restartKey$).pipe(
        // emit once immediately so the game starts right away too,
        // not only after the first 'r' press
        startWith(null),
        switchMap(() => gameSession$()),
    );

// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Removes every dynamically-drawn child from the SVG canvas before a
 * redraw, while preserving the persistent #gameOver group defined
 * statically in index.html.
 */
const clearDynamicChildren = (svg: SVGSVGElement): void => {
    Array.from(svg.children)
        .filter(child => child.id !== "gameOver")
        .forEach(child => svg.removeChild(child));
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/**
 * Draws a labelled box (rect + centred text) and appends both to 'svg'.
 * Shared by the falling-target and digit-toggle rendering, which both
 * followed this exact rect+text+append pattern with only the props and
 * label differing.
 */
const drawLabeledBox = (
    svg: SVGSVGElement,
    rectProps: Record<string, string>,
    textProps: Record<string, string>,
    label: string,
): void => {
    const box = createSvgElement(svg.namespaceURI, "rect", rectProps);
    const text = createSvgElement(svg.namespaceURI, "text", textProps);
    text.textContent = label;
    svg.appendChild(box);
    svg.appendChild(text);
};

const render = (): ((s: State) => void) => {
    // One-time static screen drawn immediately on load, before any game
    // state exists — replaced by the live game on the first render() call.
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;
    const gameOverGroup = document.querySelector("#gameOver") as SVGGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        clearDynamicChildren(svg);

        // Update score display
        const scoreElement = document.querySelector(
            "#scoreText",
        ) as HTMLElement;
        scoreElement.textContent = String(s.score);

        // check line
        const checkLine = createSvgElement(svg.namespaceURI, "line", {
            x1: "0",
            y1: `${TargetConfig.CHECK_LINE_Y}`,
            x2: `${Viewport.CANVAS_WIDTH}`,
            y2: `${TargetConfig.CHECK_LINE_Y}`,
            stroke: "red",
            "stroke-width": "2",
            "stroke-dasharray": "6,4",
        });
        svg.appendChild(checkLine);

        // Draw falling targets
        s.targets.forEach(t => {
            const box = createSvgElement(svg.namespaceURI, "rect", {
                x: `${Viewport.CANVAS_WIDTH / 2 - Target.WIDTH / 2}`,
                y: `${t.y}`,
                width: `${Target.WIDTH}`,
                height: `${Target.HEIGHT}`,
                rx: "6",
                fill: "white",
                stroke: "black",
                "stroke-width": "2",
            });
            const text = createSvgElement(svg.namespaceURI, "text", {
                x: `${Viewport.CANVAS_WIDTH / 2}`,
                y: `${t.y + Target.HEIGHT / 2 + 8}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                fill: "black",
            });
            text.textContent = t.value.toString(16).toUpperCase();
            svg.appendChild(box);
            svg.appendChild(text);
        });

        // Draw the row of digit toggles as a demonstration
        const digitWidth = Viewport.CANVAS_WIDTH / Constants.DIGIT_COUNT;
        s.digits.forEach((digit, i) => {
            const bit = createSvgElement(svg.namespaceURI, "rect", {
                x: `${i * digitWidth + 4}`,
                y: `${Viewport.CANVAS_HEIGHT - 50}`,
                width: `${digitWidth - 8}`,
                height: "40",
                fill: digit === 1 ? "#a5d6a7" : "#ef9a9a",
                stroke: "black",
                "stroke-width": "2",
            });
            const bitText = createSvgElement(svg.namespaceURI, "text", {
                x: `${i * digitWidth + digitWidth / 2}`,
                y: `${Viewport.CANVAS_HEIGHT - 22}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                fill: "black",
            });
            bitText.textContent = String(digit);
            svg.appendChild(bit);
            svg.appendChild(bitText);
        });

        const instructionText = createSvgElement(svg.namespaceURI, "text", {
            x: `${Viewport.CANVAS_WIDTH / 2}`,
            y: "16",
            "text-anchor": "middle",
            "font-family": "monospace",
            "font-size": "12",
            fill: "black",
        });
        instructionText.textContent = "Press R to restart, P to pause";
        svg.appendChild(instructionText);

        // Game over overlay
        gameOverGroup.setAttribute(
            "visibility",
            s.gameEnd ? "visible" : "hidden",
        );
        s.gameEnd ? show(gameOverGroup) : hide(gameOverGroup);

        // Pause overlay text
        s.isPaused &&
            svg.appendChild(
                (() => {
                    const pausedText = createSvgElement(
                        svg.namespaceURI,
                        "text",
                        {
                            x: `${Viewport.CANVAS_WIDTH / 2}`,
                            y: `${Viewport.CANVAS_HEIGHT / 2}`,
                            "text-anchor": "middle",
                            "font-family": "monospace",
                            "font-size": "28",
                            fill: "blue",
                        },
                    );
                    pausedText.textContent = "PAUSED, press P again to resume";
                    return pausedText;
                })(),
            );
    };
};

const svg = document.querySelector("#svgCanvas") as SVGSVGElement;
svg.setAttribute(
    "viewBox",
    `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
);
const startText = createSvgElement(svg.namespaceURI, "text", {
    x: `${Viewport.CANVAS_WIDTH / 2}`,
    y: `${Viewport.CANVAS_HEIGHT / 2}`,
    "text-anchor": "middle",
    "font-family": "monospace",
    "font-size": "24",
    fill: "black",
});
startText.textContent = "Click to start";
svg.appendChild(startText);

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    click$.pipe(switchMap(() => state$())).subscribe(render());
}
