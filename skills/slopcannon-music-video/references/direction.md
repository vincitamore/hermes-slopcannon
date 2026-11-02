# Direction and continuity

## Character consistency

- Describe reference-bound identity separately from wardrobe, pose, and setting.
- Keep permanent anatomy and signature features invariant.
- Use only characters needed in the scene. Extra references increase confusion and may increase cost.
- For ensembles without a reference, describe variation rules so the provider does not clone the lead.
- Upload one recurring individual per `character_reference` image. Never bind a multi-character lineup or grid sheet and address individuals by position (`"soldier 1–6"`, `"top-left rioter"`): the model treats each bound picture as one subject and will pop extra figures into frame or morph character scale mid-shot.
- When binding a front-facing character reference to an over-the-shoulder or forward-tracking shot where the character moves away from camera, explicitly state `"seen from behind, backs to camera"` so the model does not orient them facing the lens while moving away (walking backward).

## Vocal control

- Assign exactly one singer or explicit ensemble to each phrase.
- Use the provider’s supported dialogue or lyric annotation syntax when available.
- Keep non-singers’ mouths closed during another character’s phrase.
- For robots, animals, masks, or unusual anatomy, specify the exact visible mechanism that articulates.
- Cut at silence or phrase boundaries; never ask a scene to infer a lyric handoff across its boundary.
- A line's window, from its first word to its last, is the performance window. Keep the singer on screen, facing camera, in medium close-up or closer, with the mouth unobstructed for the whole window. The model follows the order of the shot prose over the onset: a shot written "the whale breaches, then LEAD sings" with the line at 00:00.300 plays the line over the whale and the mouth over silence. Put entrances, set pieces, time-lapses, reveals and camera pull-backs before the first word or after the last, and move the line later in the scene rather than stacking an event on it. Name the order in the shot: "LEAD speaks to camera. After the last word, the camera pulls back." Quiet background action behind a singer who stays in close-up is fine; loud action is not (next rule).
- The model lip-syncs to the whole scene chunk, not to an isolated vocal. When you author or mix the master, keep sound effects and loud one-shots under the vocal inside a performance window, and land hits before the first word or after the last. A splash mixed louder than the line under its first words drove the mouth from the splash, and it was the only scene of six that lost sync once the picture was fixed. A steady music bed under the vocal is fine. The same holds for sound the shot implies: the model generates audio for described events, even behind a singer who stays in close-up (a phone bursting out of a lake), and the mouth then follows that generated sound rather than the vocal; in the measured take it stayed closed through the two words where the model's own sound replaced the line. Keep loud described action out of the window too, and place it after the last word.
- Ask for clear, articulated delivery. "Whisper", "mumble" and "hushed" ask for a nearly still mouth, which reads as broken lip-sync.
- Keep visible lip-sync to one or two singers framed in medium or close-up facing the camera; wide full-body group shots (four or more small faces marching together) cannot produce readable mouth sync.
- When saving a workspace (`slopcannon_save_workspace`) and song analysis missed, merged, or misheard words in a `lipSyncMode: "required"` scene, supply the exact sung words for that scene's window in `sceneAudioGuidance[].whisperTranscriptOverride` (with `ignoreWhisperLyrics: false`) or as timed `<d>[Language]...</d>` spans in `sceneText`. Omit `whisperTranscriptOverride` when using the analyzed words; never send an empty `""` override on a required lip-sync scene or rely on prose telling the model to "follow the audio slice".

The CLI's `plan` writes the performance window into every vocal scene and returns `warnings` for shots whose action precedes an early line or whose delivery words still the mouth; `run` repeats them at the first-scene review stop.

## Staging: orientation and motion

For every named subject in every shot, state which way they face and which way they move, in round brackets straight after the name: `LEAD (profile, facing frame-left; walks right to left, easy pace)`. This is a standing rule for every scene, not a repair for one failure. Reference portraits are front-facing, so a shot that says nothing tends to turn every character toward the lens, and a character who travels across or away from the camera tends to be animated walking backward. The video prompt SLOPCANNON compiles tells the model to honor the facing and travel you write and, where you wrote nothing, to face subjects toward each other, their action or their path; it can only honor a direction that is written.

- **Orientation** is facing relative to the camera and frame: toward camera, away from camera, 3/4 left or right, profile facing frame-left or frame-right, or toward a named subject or object that is in the shot (`FRIEND (3/4 right, facing LEAD; static)`).
- **Motion vector** is the direction of travel in frame (left to right, right to left, toward camera, away into depth, or static) with a pace such as slow, easy, brisk or running. Write a turn or change of direction where it happens (`LEAD (profile, facing frame-left; walks right to left) turns to face FRIEND at the doorway`).
- Movement goes forward in the direction faced: facing frame-right means travelling left to right, travelling toward camera means facing it, and travelling away shows the back (`seen from behind, backs to camera`). Never pair a facing with the opposite travel. A deliberate backward step is written as one (`backs away from the door, still facing it`).
- Subjects look at each other, their action or their path, not the lens, unless the shot calls for a look to camera. A vocal performance window is that call (see Vocal control). A mascot, plush or other non-human character with a front-only reference keeps the camera in front of it: face it toward camera or 3/4 and move it toward or across the frame, never away.
- Use round brackets. Square brackets in scene text are read as reference names and fail cast resolution. Keep each vector to a few words so the scene stays within its length limit.

## Scene design

- Give each block one readable action and no more than two or three camera setups.
- Use match cuts, repeated props, direction of travel, light, or pose as continuity anchors.
- Escalate one visual idea across the whole video instead of restarting unrelated spectacle every scene.
- State forbidden text and brands by default. Permit requested diegetic text only in the exact scene and interval where it belongs.
- Make comedy visually sincere when the joke depends on committed performance.
- State camera tracking direction relative to subject motion explicitly: when characters walk or march toward a frontal camera, specify `"backward-tracking camera"` (camera retreats ahead of them). Writing `"frontal tracking"` without `"backward"` makes the camera dolly forward while characters face the lens, creating a backward-walking / moonwalk effect.
- Keep one continuous physical action in frame per 5–15 second scene; avoid mid-shot third-character grapple entrances or formation splits that cause subjects to pop or change scale.
- Keep `project.treatment` strictly to visual world, style, character identity, and story arc; never place workflow, quote, approval, or credit instructions inside `treatment`.

## Review order

1. Correct singer and line timing: look at frames across the performance window, not a single still, and confirm the singer is on screen with the mouth moving on the words.
2. Correct identity and anatomy.
3. Story beat and emotional performance.
4. Continuity into adjacent scenes.
5. Camera polish and background detail.

Do not approve a beautiful take with the wrong vocalist unless the user explicitly chooses visual quality over lyric accuracy.

Use [timed-plan.md](timed-plan.md) for exact timing and validation, and [assembly.md](assembly.md) to distinguish performed mouth movement from the final soundtrack.
