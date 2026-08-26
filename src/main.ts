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

// State processing
type State = Readonly<{
    digits: ReadonlyArray<Digit>; // 8-bit row, index 0 = MSB
    gameEnd: boolean;
}>;

const initialState: State = {
    digits: Array(Constants.DIGIT_COUNT).fill(0),
    gameEnd: false,
};

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

class Tick implements Action {
    constructor(public readonly elapsed: number) {}

    apply(s: State): State {
        // falling-target movement & collision logic will live here
        return s;
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

export const state$ = (): Observable<State> =>
    merge(flip$, tick$).pipe(scan(reduceState, initialState));


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
        // Draw a static falling target as a demonstration
        const target = createSvgElement(svg.namespaceURI, "rect", {
            x: `${Viewport.CANVAS_WIDTH / 2 - Target.WIDTH / 2}`,
            y: "40",
            width: `${Target.WIDTH}`,
            height: `${Target.HEIGHT}`,
            rx: "6",
            fill: "white",
            stroke: "black",
            "stroke-width": "2",
        });
        const targetText = createSvgElement(svg.namespaceURI, "text", {
            x: `${Viewport.CANVAS_WIDTH / 2}`,
            y: `${40 + Target.HEIGHT / 2 + 8}`,
            "text-anchor": "middle",
            "font-family": "monospace",
            fill: "black",
        });
        targetText.textContent = "13";
        svg.appendChild(target);
        svg.appendChild(targetText);

        // Draw the row of digit toggles as a demonstration
        const digitWidth = Viewport.CANVAS_WIDTH / Constants.DIGIT_COUNT;
        Array.from({ length: Constants.DIGIT_COUNT }).forEach((_, i) => {
            const bit = createSvgElement(svg.namespaceURI, "rect", {
                x: `${i * digitWidth + 4}`,
                y: `${Viewport.CANVAS_HEIGHT - 50}`,
                width: `${digitWidth - 8}`,
                height: "40",
                fill: "#ef9a9a",
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
            bitText.textContent = "0";
            svg.appendChild(bit);
            svg.appendChild(bitText);
        });
    };
};

// export const state$ = (): Observable<State> => {
//     /** Determines the rate of time steps */
//     const tick$ = interval(Constants.TICK_RATE_MS);

//     return tick$.pipe(scan((s: State) => ({ gameEnd: false }), initialState));
// };

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    click$.pipe(switchMap(() => state$())).subscribe(render());
}
