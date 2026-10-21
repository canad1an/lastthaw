# Unit pictures

The illustrated unit pictures under `apps/web/public/units/<id>.png` are generated images (one per unit id in
`packages/shared/src/config/ages.ts`), with the white background knocked out by `cutout.py`:

    python -P cutout.py in.jpg out.png 256

Every prompt ends with the same style line so the set stays consistent:

> Clean flat cartoon clip-art style with soft cel shading and simple dark outlines, warm natural colours, one subject
> only, centred, seen from a slight three-quarter angle, no text, no scenery, no background elements, on a plain pure
> white background.

People are "full figure standing", vehicles and engines "no people", ships "no water". After adding a png, regenerate
`apps/web/src/components/unitPictures.ts` so it lists every file in the folder; `UnitIcon` falls back to its line
drawing for any unit without a picture.
