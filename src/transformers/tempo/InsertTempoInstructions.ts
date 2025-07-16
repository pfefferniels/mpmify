import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, generateId, TransformationOptions } from "../Transformer";
import { TempoWithEndDate, computeMillisecondsAt } from "./tempoCalculations";
import { ApproximateLogarithmicTempo } from "./ApproximateLogarithmicTempo";

export interface BeatLengthMarker {
    date: number;
    beatLength: number;
}

export interface SilentOnset {
    date: number;
    onset: number;
}

export interface InsertTempoInstructionsOptions extends TransformationOptions {
    /**
     * Defines on which part to apply the transformer to.
     * @default 'global'
     */
    part: Scope;
    
    /**
     * Beat length markers that define tempo segments
     */
    markers: BeatLengthMarker[];
    
    /**
     * Silent onsets for tempo calculation
     */
    silentOnsets: SilentOnset[];
}

/**
 * Inserts tempo instructions into the MPM based on the timing data in the MSM.
 * This transformer analyzes the actual performed timing and creates tempo instructions
 * that best approximate the performance.
 */
export class InsertTempoInstructions extends AbstractTransformer<InsertTempoInstructionsOptions> {
    name = 'InsertTempoInstructions';
    requires = [];

    constructor(options?: InsertTempoInstructionsOptions) {
        super();
        
        // Set default options
        this.options = options || {
            part: 'global',
            markers: [],
            silentOnsets: []
        };
    }

    protected transform(msm: MSM, mpm: MPM): void {
        if (this.options.markers.length === 0) {
            return;
        }

        // Create tempo segments based on markers
        const segments = this.createTempoSegments(msm);
        
        // Insert tempo instructions for each segment
        for (const segment of segments) {
            this.insertTempoForSegment(segment, msm, mpm);
        }
    }

    private createTempoSegments(msm: MSM) {
        const segments = [];
        
        for (let i = 0; i < this.options.markers.length; i++) {
            const marker = this.options.markers[i];
            const nextMarker = this.options.markers[i + 1];
            
            const startDate = marker.date;
            const endDate = nextMarker ? nextMarker.date : msm.getLastNoteEnd();
            
            segments.push({
                startDate,
                endDate,
                beatLength: marker.beatLength,
                measureBeatLength: marker.beatLength
            });
        }
        
        return segments;
    }

    private insertTempoForSegment(segment: any, msm: MSM, mpm: MPM): void {
        // Get notes in this segment
        const segmentNotes = msm.allNotes.filter(note => 
            note.date >= segment.startDate && note.date < segment.endDate
        );

        if (segmentNotes.length < 2) {
            // Not enough notes to calculate tempo, insert a default tempo
            this.insertDefaultTempo(segment, mpm);
            return;
        }

        // Create points for tempo approximation
        const points: [number, number][] = segmentNotes.map(note => [
            note.date,
            note['midi.onset'] * 1000 // Convert to milliseconds
        ]);

        // Use ApproximateLogarithmicTempo to create tempo instructions
        const tempoApproximator = new ApproximateLogarithmicTempo({
            segment: {
                ...segment,
                points
            },
            silentOnsets: this.options.silentOnsets,
            part: this.options.part
        });

        // Apply the tempo approximation
        tempoApproximator.transform(msm, mpm);
    }

    private insertDefaultTempo(segment: any, mpm: MPM): void {
        // Insert a default tempo of 60 BPM
        const tempoId = generateId('tempo', segment.startDate, mpm);
        
        const tempo: Tempo = {
            'xml:id': tempoId,
            date: segment.startDate,
            bpm: 60,
            beatLength: segment.beatLength / (4 * 720) // Convert to quarter note length
        };

        mpm.addInstruction(tempo, this.options.part);
        this.created.push(tempoId);
    }
}