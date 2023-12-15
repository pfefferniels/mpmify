export const isDefined = (onset?: number) => {
    return onset !== undefined && !isNaN(onset)
}
