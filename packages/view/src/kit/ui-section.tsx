import { ButtonsKit } from "./buttons-kit.tsx";
import { ControlsKit } from "./controls-kit.tsx";
import { FieldsKit } from "./fields-kit.tsx";
import { KitSection } from "./kit-section.tsx";
import { LabelsKit } from "./labels-kit.tsx";
import { OverlaysKit } from "./overlays-kit.tsx";
import { StatesKit } from "./states-kit.tsx";

/** The components of src/ui, each in its states. */
export function UiSection() {
  return (
    <>
      <KitSection id="kit-ui" title="Buttons and menus">
        <ButtonsKit />
      </KitSection>
      <KitSection id="kit-overlays" title="Dialogs, toasts and search">
        <OverlaysKit />
      </KitSection>
      <KitSection id="kit-controls" title="Switches and sections">
        <ControlsKit />
      </KitSection>
      <KitSection id="kit-fields" title="Fields">
        <FieldsKit />
      </KitSection>
      <KitSection id="kit-labels" title="Labels">
        <LabelsKit />
      </KitSection>
      <KitSection id="kit-states" title="Empty, loading and refused">
        <StatesKit />
      </KitSection>
    </>
  );
}
