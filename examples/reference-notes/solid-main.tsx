/** @jsxImportSource @nexa/adapter-solid */

import { render } from "@nexa/adapter-solid";

import { createSolidNotesController, SolidNotesApp } from "./solid-app.js";

const controller = createSolidNotesController();

render(() => <SolidNotesApp controller={controller} />);
