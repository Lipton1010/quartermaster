/**
 * Quartermaster — Resource Edit Dialog (step 14)
 *
 * Create-or-edit dialog for custom resources. Used by the GM Loot Prep
 * popup. GM only.
 *
 * Returns the form data on Confirm, or null on cancel / X / escape.
 */

import { MODULE_TITLE } from "../constants.js";
import { DEFAULT_RESOURCE_ICON } from "../resources.js";

const { DialogV2 } = foundry.applications.api;

/**
 * @param {Object} options
 * @param {Object} [options.resource] - existing resource for edit mode; null for create
 * @returns {Promise<Object|null>} { name, icon, value, max, description } or null
 */
export async function promptResourceEdit({ resource = null } = {}) {
  const isEdit = !!resource;
  const title = isEdit ? `Edit Resource: ${resource.name}` : "Add New Resource";

  const safe = (s) => (typeof s === "string" ? s.replace(/"/g, "&quot;") : "");

  const initial = {
    name: resource?.name ?? "",
    icon: resource?.icon ?? DEFAULT_RESOURCE_ICON,
    value: resource?.value ?? 0,
    max: resource?.max ?? "",
    description: resource?.description ?? ""
  };

  const content = `
    <div class="qm-resource-edit">
      <div class="form-group">
        <label for="qm-res-name">Name</label>
        <input type="text" id="qm-res-name" name="name"
               value="${safe(initial.name)}"
               placeholder="e.g. Healing Charges" autofocus required />
      </div>

      <div class="form-group qm-resource-icon-row">
        <label for="qm-res-icon">Icon</label>
        <div class="qm-resource-icon-control">
          <img class="qm-resource-icon-preview"
               src="${safe(initial.icon)}"
               alt="" />
          <input type="text" id="qm-res-icon" name="icon"
                 value="${safe(initial.icon)}" />
          <button type="button" class="qm-pick-icon" title="Browse for icon">
            <i class="fa-solid fa-folder-open"></i>
          </button>
        </div>
      </div>

      <div class="form-group qm-resource-numbers">
        <div>
          <label for="qm-res-value">Current value</label>
          <input type="number" id="qm-res-value" name="value"
                 value="${initial.value}" min="0" step="1" />
        </div>
        <div>
          <label for="qm-res-max">Max (blank = unlimited)</label>
          <input type="number" id="qm-res-max" name="max"
                 value="${initial.max}" min="1" step="1" placeholder="—" />
        </div>
      </div>

      <div class="form-group">
        <label for="qm-res-desc">Description (optional)</label>
        <textarea id="qm-res-desc" name="description"
                  rows="2" placeholder="Notes shown in tooltip">${safe(initial.description)}</textarea>
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch { /* ignore */ }
      }
      resolve(value);
    };

    const readForm = (dlg) => {
      const root = dlg.element;
      if (!root) return null;
      const name = root.querySelector("#qm-res-name")?.value?.trim() ?? "";
      const icon = root.querySelector("#qm-res-icon")?.value?.trim() ?? "";
      const valueRaw = root.querySelector("#qm-res-value")?.value;
      const maxRaw = root.querySelector("#qm-res-max")?.value;
      const description = root.querySelector("#qm-res-desc")?.value?.trim() ?? "";

      if (!name) {
        ui.notifications.warn(`${MODULE_TITLE}: name is required.`);
        return null;
      }

      const value = parseInt(valueRaw, 10);
      const max = maxRaw === "" ? null : parseInt(maxRaw, 10);

      return {
        name,
        icon: icon || DEFAULT_RESOURCE_ICON,
        value: Number.isFinite(value) ? value : 0,
        max: max != null && Number.isFinite(max) && max > 0 ? max : null,
        description
      };
    };

    const dialog = new DialogV2({
      window: {
        title,
        icon: isEdit ? "fa-solid fa-pen-to-square" : "fa-solid fa-plus"
      },
      position: { width: 460 },
      classes: ["quartermaster"],
      content,
      buttons: [
        {
          action: "save",
          label: isEdit ? "Save" : "Add",
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button, dlg) => {
            const data = readForm(dlg);
            if (!data) {
              // Validation failed; keep the dialog open by not resolving
              throw new Error("validation-failed");
            }
            finish(data);
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => finish(null)
        }
      ],
      rejectClose: false
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      if (!resolved) finish(null);
    });

    dialog.render({ force: true }).then(() => {
      const root = dialog.element;
      if (!root) return;

      // Live icon preview as the path changes
      const iconInput = root.querySelector("#qm-res-icon");
      const preview = root.querySelector(".qm-resource-icon-preview");
      if (iconInput && preview) {
        iconInput.addEventListener("input", () => {
          preview.src = iconInput.value || DEFAULT_RESOURCE_ICON;
        });
      }

      // File picker for icon
      const pickBtn = root.querySelector(".qm-pick-icon");
      if (pickBtn && iconInput) {
        pickBtn.addEventListener("click", async () => {
          const fp = new foundry.applications.apps.FilePicker.implementation({
            type: "image",
            current: iconInput.value,
            callback: (path) => {
              iconInput.value = path;
              if (preview) preview.src = path;
            }
          });
          fp.render(true);
        });
      }
    });
  });
}
