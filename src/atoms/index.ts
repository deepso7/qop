import { atom, useAtom, useSetAtom } from "jotai";

const camAtom = atom(true);
const micAtom = atom(true);
const nameAtom = atom("");

export const useSetName = () => useSetAtom(nameAtom);

export const useCamState = () => useAtom(camAtom);
export const useMicState = () => useAtom(micAtom);
export const useNameState = () => useAtom(nameAtom);
