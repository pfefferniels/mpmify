import { Tempo } from "../mpm";
import { MsmNote } from "../msm";

export const physicalToSymbolic = (physicalDate: number, bpm: number, beatLength: number) => {
    return (physicalDate * (bpm * beatLength * 4 / 60)) * 720
}

export const symbolicToPhysical = (symbolic: number, bpm: number, beatLength: number) => {
    return ((15000 * symbolic) / (bpm * beatLength * 720) / 1000);
}

export function calculateSymbolicNoteDuration(note: MsmNote, tempos: Tempo[]) {
    tempos.sort((a, b) => a.date - b.date)
    let fullDuration = 0
    let remaining = note['midi.duration']
    for (let i = 0; i < tempos.length; i++) {
        const startDate = Math.max(note.date, tempos[i].date)
        let localDuration = remaining
        if (i < tempos.length - 1) {
            localDuration = Math.min(symbolicToPhysical(tempos[i + 1].date - startDate, tempos[i].bpm, tempos[i].beatLength),
                localDuration)
        }

        fullDuration += physicalToSymbolic(localDuration, tempos[i].bpm, tempos[i].beatLength)
        remaining -= localDuration
    }
    return fullDuration
}
