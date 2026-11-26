// The types of world.mjs, so the checks in TypeScript can use it.

export type World = { root: string; home: string; sousHome: string; project: string; fake: string };

export function worldAt(root: string): World;
export function makeWorld(root?: string): World;
export function personEnv(world: World, extra?: Record<string, string>): NodeJS.ProcessEnv;
