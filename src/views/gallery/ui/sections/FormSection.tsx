import {
	Moon02Icon,
	SearchList01Icon,
	Sun01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@/shared/ui/input-group";
import { NumberStepper } from "@/shared/ui/number-stepper";
import { Slider } from "@/shared/ui/slider";
import { Switcher } from "@/shared/ui/switcher";
import {
	ClearableTextField,
	PasswordField,
	StoredSecretField,
	TextField,
} from "@/shared/ui/text-field";
import { Toggle } from "@/shared/ui/toggle";
import { DemoRow, GallerySection } from "../GallerySection";

type ThemeOption = "light" | "dark" | "auto";

export function FormSection() {
	const t = useTranslations("gallery");
	const tCommon = useTranslations("common");
	const [text, setText] = useState("");
	// Lazy initializer: `useState(t(...))` would re-run the translation on
	// every render only to throw the result away.
	const [clearable, setClearable] = useState(() => t("clearablePrefill"));
	const [password, setPassword] = useState("hunter2");
	const [steps, setSteps] = useState(2);
	const [volume, setVolume] = useState(65);
	const [toggled, setToggled] = useState(true);
	const [theme, setTheme] = useState<ThemeOption>("auto");
	const [checked, setChecked] = useState<Set<number>>(() => new Set([0, 1]));

	const toggleIndex = (index: number) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	const checkboxLabels = [
		t("checkboxOption1"),
		t("checkboxOption2"),
		t("checkboxOption3"),
		t("checkboxOption4"),
	];

	return (
		<GallerySection
			description={t("formDescription")}
			id="form"
			title={t("formTitle")}
		>
			<DemoRow label={t("rowTextFields")}>
				<FormControl
					caption={t("textFieldCaption")}
					className="w-64"
					label={t("textFieldLabel")}
				>
					<TextField
						onChange={(event) => setText(event.target.value)}
						placeholder={t("textFieldPlaceholder")}
						value={text}
					/>
				</FormControl>
				<FormControl className="w-64" label={t("clearableLabel")}>
					<ClearableTextField
						clearLabel={t("clearableClear")}
						leadingIcon={
							<HugeiconsIcon
								aria-hidden="true"
								icon={SearchList01Icon}
								size={15}
							/>
						}
						onValueChange={setClearable}
						placeholder={t("clearablePlaceholder")}
						type="text"
						value={clearable}
					/>
				</FormControl>
			</DemoRow>
			<DemoRow label={t("rowSecrets")}>
				<FormControl className="w-64" label={t("passwordLabel")}>
					<PasswordField
						hideLabel={tCommon("hidePassword")}
						onChange={(event) => setPassword(event.target.value)}
						revealLabel={tCommon("showPassword")}
						value={password}
					/>
				</FormControl>
				<FormControl className="w-64" label={t("storedSecretLabel")}>
					<StoredSecretField aria-label={t("storedSecretLabel")} />
				</FormControl>
			</DemoRow>
			<DemoRow label={t("rowInputGroup")}>
				<InputGroup className="w-72">
					<InputGroupAddon>
						<InputGroupText>{t("inputGroupPrefix")}</InputGroupText>
					</InputGroupAddon>
					<InputGroupInput placeholder={t("inputGroupPlaceholder")} />
					<InputGroupAddon align="inline-end">
						<InputGroupText>{t("inputGroupSuffix")}</InputGroupText>
					</InputGroupAddon>
				</InputGroup>
			</DemoRow>
			<DemoRow label={t("rowNumbersSliders")}>
				<NumberStepper max={8} min={1} onChange={setSteps} value={steps} />
				<Slider
					aria-label={t("sliderLabel")}
					className="w-56"
					max={100}
					min={0}
					onChange={setVolume}
					step={5}
					value={volume}
				/>
			</DemoRow>
			<DemoRow label={t("rowToggleSwitcher")}>
				<Toggle
					checked={toggled}
					label={t("toggleLabel")}
					onCheckedChange={setToggled}
				/>
				<Switcher<ThemeOption>
					onChange={setTheme}
					options={[
						{ value: "light", label: t("switcherLight"), icon: Sun01Icon },
						{ value: "dark", label: t("switcherDark"), icon: Moon02Icon },
						{ value: "auto", label: t("switcherAuto") },
					]}
					value={theme}
				/>
			</DemoRow>
			<DemoRow label={t("rowCheckboxGroup")}>
				<ElevatedSurface className="w-72">
					<CheckboxGroup
						aria-label={t("rowCheckboxGroup")}
						checkedIndices={checked}
					>
						{checkboxLabels.map((label, index) => (
							<CheckboxItem
								checked={checked.has(index)}
								index={index}
								key={label}
								label={label}
								onToggle={() => toggleIndex(index)}
							/>
						))}
					</CheckboxGroup>
				</ElevatedSurface>
			</DemoRow>
		</GallerySection>
	);
}
