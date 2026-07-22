# Creature attack sounds

Drop audio clips (`.mp3`, `.ogg`, `.wav`, or `.m4a`) into a subfolder here, one
top-level folder per creature type - e.g.:

```
assets/creature-sounds/
  dragons/
    roar1.mp3
    DRAGON ROAR/
      ROAR 1.wav
      ROAR 2.wav
    DRAGON BREATHING FIRE/
      fire1.wav
  goblins/
    screech1.mp3
```

Clips can be organized into as many nested subfolders as you like within a
creature type - `dragons/DRAGON ROAR/ROAR 1.wav` and `dragons/roar1.mp3` both
count as "dragons" clips and are picked from the same pool. Subfolders are
just for your own organization; they aren't separately selectable.

The top-level folder name (`dragons`, `goblins`, ...) is exactly what shows up:

- as an option in a token's "Sound folder" dropdown (Add Token form / token
  card) - set it once per enemy/npc token and a random clip from that folder
  plays automatically whenever the token attacks (hit or miss).
- as a button in the GM's Soundboard panel, to trigger a random clip from
  that folder on demand at any time.

`dragons/` and `goblins/` above are just placeholders to show the expected
layout - add real clips (or new folders) and they'll show up after a server
restart (the folder list is cached once per process, same as the bundled
music/effects libraries).
