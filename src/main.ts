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
    catchError,
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

/** Constants */

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
    TICK_RATE_MS: 500, // Might need to change this!
} as const;

// types
type Digit = 0 | 1; 

type FallingTarget = Readonly<{
    value: number; // 0-15, the hex digit the player must match
    y: number;     // current vertical position
}>;

// State processing
type State = Readonly<{
    digits: ReadonlyArray<Digit>; // 8-bit row, index 0 = MSB
    targets: ReadonlyArray<FallingTarget>;
    nextTargetIndex: number;      // position in TARGET_SEQUENCE for next spawn
    seed: number; // current RNG seed
    ticksSinceLastSpawn: number;  // counts up each tick, resets on spawn
    gameEnd: boolean;
}>;

const TARGET_SEQUENCE: ReadonlyArray<number> = [13, 5, 10, 2, 15, 8];

const TargetConfig = {
    FALL_SPEED: 6, // px per tick
    CHECK_LINE_Y: Viewport.CANVAS_HEIGHT - 120,
    SPAWN_Y: 20,
    SPAWN_INTERVAL_TICKS: 8,
} as const;

// Minimum ms between spawns so a target clears its own height before the
// next one spawns at the same y position, plus a small safety margin.
// const MIN_SPAWN_DELAY_MS =
//     ((Target.HEIGHT + 20) / TargetConfig.FALL_SPEED) * Constants.TICK_RATE_MS;

const MIN_SPAWN_DELAY_MS = 2000;
const MAX_SPAWN_DELAY_MS = 3000

const MIN_SPAWN_DELAY_TICKS = Math.ceil(
    MIN_SPAWN_DELAY_MS / Constants.TICK_RATE_MS,
);
// const initialState: State = {
//     digits: Array(Constants.DIGIT_COUNT).fill(0),
//     targets: [{ value: TARGET_SEQUENCE[0], y: TargetConfig.SPAWN_Y }],
//     nextTargetIndex: 1,
//     seed: Date.now(), // varies per run
//     ticksSinceLastSpawn: 0,
//     gameEnd: false,
// };

/** Maps a [0,1) scaled seed value into a spawn-delay range. Pure. */
const seedToSpawnDelay = (scaledSeed: number): number =>
    MIN_SPAWN_DELAY_MS + scaledSeed * (MAX_SPAWN_DELAY_MS - MIN_SPAWN_DELAY_MS);

const digitsToNumber = (digits: ReadonlyArray<Digit>): number =>
    digits.reduce<number>((acc, d) => acc * 2 + d, 0);

// actions
interface Action {
    apply(s: State): State;
}

class FlipDigit implements Action {
    constructor(public readonly index: number) {}

    apply(s: State): State {
        return {
            ...s,
            digits: s.digits.map((d, i) =>
                i === this.index ? ((1 - d) as Digit) : d,
            ),
        };
    }
}

/**
 * A pure, seedable pseudo-random number generator (Linear Congruential Generator).
 * Given the same seed, hash() always produces the same next value 
 * making randomness deterministic and testable rather than a hidden side effect.
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

class SpawnTarget implements Action {
    apply(s: State): State {
        const nextValue = TARGET_SEQUENCE[s.nextTargetIndex];
        return nextValue === undefined
            ? s
            : {
                  ...s,
                  targets: [
                      ...s.targets,
                      { value: nextValue, y: TargetConfig.SPAWN_Y },
                  ],
                  nextTargetIndex: s.nextTargetIndex + 1,
                  seed: RNG.hash(s.seed), // advance the seed deterministically
              };
    }
}

class Tick implements Action {
    constructor(public readonly elapsed: number) {}

    apply(s: State): State {
        // falling-target movement & collision logic will live here
        const movedTargets = s.targets.map((t) => ({
            ...t,
            y: t.y + TargetConfig.FALL_SPEED,
        }));

        const lowest = movedTargets[0];

        // Check for a match every tick, regardless of position
        const isMatch =
            lowest !== undefined &&
            digitsToNumber(s.digits) === lowest.value;

        // Only a miss if it reached the line w/o a match
        const isMissedAtLine =
            lowest !== undefined &&
            !isMatch &&
            lowest.y >= TargetConfig.CHECK_LINE_Y;

        const targetsAfterCollision = isMatch
            ? movedTargets.slice(1)
            : movedTargets;
        
        // advance seed every tick regardless,
        // spawn when the scaled value crosses a threshold.
        const nextSeed = RNG.hash(s.seed);
        const roll = RNG.scale(nextSeed);
        const spawnThresholdPerTick =
            Constants.TICK_RATE_MS /
            ((MIN_SPAWN_DELAY_MS + MAX_SPAWN_DELAY_MS) / 2);
        
        const ticksSinceLastSpawn = s.ticksSinceLastSpawn + 1;
        const canSpawnMore = s.nextTargetIndex < TARGET_SEQUENCE.length;
        const pastMinGap = ticksSinceLastSpawn >= MIN_SPAWN_DELAY_TICKS;
        // Spawn either from the normal random timer, or immediately
        // because the previous target was just resolved.
        const readyToSpawn =
            canSpawnMore && pastMinGap && roll < spawnThresholdPerTick;

        const targetsAfterSpawn = readyToSpawn
            ? [
                  ...targetsAfterCollision,
                  {
                      value: TARGET_SEQUENCE[s.nextTargetIndex],
                      y: TargetConfig.SPAWN_Y,
                  },
              ]
            : targetsAfterCollision;

        return s.gameEnd
            ? s
              : {
                    ...s,
                    targets: targetsAfterSpawn,
                    nextTargetIndex: readyToSpawn
                        ? s.nextTargetIndex + 1
                        : s.nextTargetIndex,
                    seed: nextSeed,
                    ticksSinceLastSpawn: readyToSpawn ? 0 : ticksSinceLastSpawn,
                    gameEnd: isMissedAtLine ? true : s.gameEnd,
                };
    }
}

// reducer just delegates
const reduceState = (s: State, action: Action): State => action.apply(s);

// streams
const flip$ = fromEvent<KeyboardEvent>(document, "keypress").pipe(
    filter((e) => /^[1-8]$/.test(e.key)),
    map((e) => new FlipDigit(Number(e.key) - 1)),
);

const tick$ = interval(Constants.TICK_RATE_MS).pipe(
    map((elapsed) => new Tick(elapsed)),
);

const canvasElement = document.querySelector("#svgCanvas") as SVGSVGElement;

const digitClick$ = fromEvent<MouseEvent>(canvasElement, "mousedown").pipe(
    map((e) => {
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
    filter((index) => index !== -1),
    map((index) => new FlipDigit(index)),
);

const restartKey$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter((e) => e.key === "r" || e.key === "R"),
);

const makeInitialState = (): State => ({
    digits: Array(Constants.DIGIT_COUNT).fill(0),
    targets: [{ value: TARGET_SEQUENCE[0], y: TargetConfig.SPAWN_Y }],
    nextTargetIndex: 1,
    seed: Date.now(),
    ticksSinceLastSpawn: 0,
    gameEnd: false,
});

export const gameSession$ = (): Observable<State> =>
    merge(flip$, tick$, digitClick$).pipe(scan(reduceState, makeInitialState()));

export const state$ = (): Observable<State> =>
    merge(restartKey$).pipe(
        // emit once immediately so the game starts right away too,
        // not only after the first 'r' press
        startWith(null),
        switchMap(() => gameSession$()),
    );


/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
//const tick = (s: State) => s;

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

const render = (): ((s: State) => void) => {
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

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
        svg.innerHTML = ""; // clear last frame before drawing this one

        const debugText = createSvgElement(svg.namespaceURI, "text", {
            x: "10",
            y: "20",
            "font-family": "monospace",
            "font-size": "14",
            fill: "black",
        });
        debugText.textContent = `value=${digitsToNumber(s.digits)} gameEnd=${s.gameEnd}`;
        svg.appendChild(debugText);

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
        s.targets.forEach((t) => {
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
        instructionText.textContent = "Press R to restart";
        svg.appendChild(instructionText);

        // Game over overlay
        s.gameEnd && svg.appendChild(
            (() => {
                const gameOverText = createSvgElement(svg.namespaceURI, "text", {
                    x: `${Viewport.CANVAS_WIDTH / 2}`,
                    y: `${Viewport.CANVAS_HEIGHT / 2}`,
                    "text-anchor": "middle",
                    "font-family": "monospace",
                    "font-size": "32",
                    fill: "red",
                });
                gameOverText.textContent = "GAME OVER";
                return gameOverText;
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
