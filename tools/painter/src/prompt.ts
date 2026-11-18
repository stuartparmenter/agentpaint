// The painter's prompts. They are identical for every model and every strokes per
// assignment setting in an experiment, and their hash (sent with every stroke)
// identifies them. They describe the tools' mechanics; creative choices are left
// to the painter. They come in two variants: for paintings the agent can end early
// with finished: true, and for paintings that end when their stroke budget is used.

import { createHash } from "node:crypto";

const SYSTEM_BEFORE_ENDING = `You paint on an AgentPaint canvas through two tools.

get_assignment gives you an assignment on the painting. A new assignment returns the painting's metadata, then the reference image (when the painting has one) and the current canvas, each labeled. metadata.assignment_strokes_remaining is how many strokes this assignment still allows; metadata.painting_strokes_remaining is how many strokes are left in the painting's budget. While assignment_strokes_remaining is above zero, get_assignment returns the same token and metadata with new_assignment false, and the images as they were when the assignment started.

submit_stroke paints with the assignment's token: stroke_data for one stroke, or strokes for several at once (up to assignment_strokes_remaining, at most 50 per call). Each reply gives the updated assignment_strokes_remaining and painting_strokes_remaining. Strokes apply in the order given. Give each stroke a note: one line saying what it is for.

metadata.prompt is the painting's subject, or null when none is given. When the painting has a reference image, the painting is a painting of that reference.

Stroke format (canvas pixels, origin top-left; metadata gives canvas_width and canvas_height):
- points: 2-50 control points {x, y, pressure}; the path is smoothed through them. Pressure 0-1 slightly scales width; below 0.1 no paint is laid down.
- brush: size (diameter in pixels), hardness (0 soft to 1 crisp), opacity (maximum opacity of this stroke), flow (paint per pass, builds toward opacity).
- color: {r, g, b} 0-255.
- speed: optional pixels/second.

The medium is acrylic: each stroke dries before the next, and an opaque stroke covers what is under it; low opacity and flow layer translucently.

`;

const ENDING_WITH_FINISH =
  "max_strokes is a ceiling. Set finished: true on a submit_stroke call to end the painting after its strokes (or with no strokes). Finishing is permanent: no later assignment can add to the painting.";

const ENDING_WITHOUT_FINISH = "The painting ends when max_strokes strokes have been painted.";

const SYSTEM_AFTER_ENDING = `

If submit_stroke rejects strokes, read the reason: for invalid_stroke or too_many_strokes, fix them and resubmit with the same token (index names the first rejected stroke of a batch); for temporary_failure, resubmit the strokes that were not applied; for stale_assignment or token_expired, call get_assignment again.`;

/** The user turn of every conversation: one assignment. Each assignment is a new conversation. */
function assignmentTurn(allowFinish: boolean): string {
  return `This conversation is one assignment in a longer painting. Later assignments continue the painting, each in a new conversation, until the painting's stroke budget is used${allowFinish ? " or it is finished" : ""}. Call get_assignment, then use the assignment's strokes with submit_stroke. Stop when the assignment has no strokes remaining, and reply with one line about what you did.`;
}

export interface Prompts {
  /** The system prompt of every conversation. */
  system: string;
  /** The user turn of every conversation. */
  turn: string;
  /** SHA-256 of both prompts, in order (first 16 hex chars). */
  hash: string;
}

/** The prompts for a painting the agent can end early (`allowFinish`) or not. */
export function promptsFor(allowFinish: boolean): Prompts {
  const system =
    SYSTEM_BEFORE_ENDING + (allowFinish ? ENDING_WITH_FINISH : ENDING_WITHOUT_FINISH) + SYSTEM_AFTER_ENDING;
  const turn = assignmentTurn(allowFinish);
  const hash = createHash("sha256")
    .update(JSON.stringify([system, turn]))
    .digest("hex")
    .slice(0, 16);
  return { system, turn, hash };
}
