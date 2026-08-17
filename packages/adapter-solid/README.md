# @nexa/adapter-solid

Solid `createRenderer` (universal) mapped onto the NUI Host Protocol.

## Usage

1. Compile JSX with `babel-preset-solid`:

```json
{
  "presets": [
    [
      "babel-preset-solid",
      {
        "moduleName": "@nexa/adapter-solid",
        "generate": "universal"
      }
    ]
  ]
}
```

2. Import `render` / control flow from `@nexa/adapter-solid` (not `solid-js/web`).

3. `perry compile` the Babel output (Perry does not run `babel-preset-solid` itself).

## Host tags

`window` | `column` | `row` | `view` | `text` | `button` | `scroll`
