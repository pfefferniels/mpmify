/*
      <accentuationPatternDef name="quad time" length="4.0">
        <accentuation beat="1" value="1.0" transition.from="0.0" transition.to="0.25"/>
        <accentuation beat="2.5" value="0.5" transition.from="-0.5" transition.to="-1"/>
        <accentuation beat="4" value="0.5" transition.from="0.0" transition.to="1.0"/>
      </accentuationPatternDef>

      <accentuationPatternDef name="good-bad" length="1.0">
        <accentuation beat="1" value="1.0" transition.to="-1"/>
        <accentuation beat="2.5" value="0.5" transition.from="-0.5" transition.to="-1"/>
        <accentuation beat="4" value="0.5" transition.from="0.0" transition.to="1.0"/>
      </accentuationPatternDef>

user input: 
frames, consisting of:
startDate, endDate
beat length


for (let date=frame.startDate; date < frame.endDate; date += beatLength * 4 * ppq) {
  const notesAtDate = msm.notesAtDate
}

output:
@length = (end - start) / 4 / ppq

@transition.from is not used
@stickToMeasures = false always

      */