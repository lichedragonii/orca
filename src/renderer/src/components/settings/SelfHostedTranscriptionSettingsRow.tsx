import { Server } from 'lucide-react'
import { Label } from '../ui/label'
import { DebouncedSettingsTextInput } from './DebouncedSettingsTextInput'
import { resolveSelfHostedTranscriptionUrl } from '../../../../shared/self-hosted-transcription-url'
import { translate } from '@/i18n/i18n'

type SelfHostedTranscriptionSettingsRowProps = {
  serverUrl: string
  model: string
  disabled: boolean
  onServerUrlChange: (serverUrl: string) => void
  onModelChange: (model: string) => void
}

export function SelfHostedTranscriptionSettingsRow({
  serverUrl,
  model,
  disabled,
  onServerUrlChange,
  onModelChange
}: SelfHostedTranscriptionSettingsRowProps): React.JSX.Element {
  const trimmedUrl = serverUrl.trim()
  const endpoint = trimmedUrl ? resolveSelfHostedTranscriptionUrl(trimmedUrl) : null
  const urlInvalid = trimmedUrl !== '' && endpoint === null

  return (
    <div className="space-y-3 py-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <Label>
            {translate(
              'auto.components.settings.SelfHostedTranscriptionSettingsRow.title',
              'Self-hosted Transcription Server'
            )}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.SelfHostedTranscriptionSettingsRow.description',
            'Audio is sent to this OpenAI-compatible server when dictation stops.'
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="self-hosted-speech-url">
          {translate(
            'auto.components.settings.SelfHostedTranscriptionSettingsRow.urlLabel',
            'Server URL'
          )}
        </Label>
        <DebouncedSettingsTextInput
          id="self-hosted-speech-url"
          type="url"
          value={serverUrl}
          commit={(next) => onServerUrlChange(next.trim())}
          placeholder="http://asr-host:8002"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={urlInvalid}
        />
        {urlInvalid ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.settings.SelfHostedTranscriptionSettingsRow.urlInvalid',
              'Enter an http:// or https:// address.'
            )}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {endpoint
              ? translate(
                  'auto.components.settings.SelfHostedTranscriptionSettingsRow.endpoint',
                  'Requests go to {{value0}}',
                  { value0: endpoint }
                )
              : translate(
                  'auto.components.settings.SelfHostedTranscriptionSettingsRow.urlHint',
                  'Required. The /v1/audio/transcriptions path is added automatically.'
                )}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="self-hosted-speech-model">
          {translate(
            'auto.components.settings.SelfHostedTranscriptionSettingsRow.modelLabel',
            'Model name'
          )}
        </Label>
        <DebouncedSettingsTextInput
          id="self-hosted-speech-model"
          type="text"
          value={model}
          commit={(next) => onModelChange(next.trim())}
          placeholder={translate(
            'auto.components.settings.SelfHostedTranscriptionSettingsRow.modelPlaceholder',
            'Server default'
          )}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.SelfHostedTranscriptionSettingsRow.modelHint',
            "Must match the server's model ID. Leave blank to use the server default."
          )}
        </p>
      </div>
    </div>
  )
}
