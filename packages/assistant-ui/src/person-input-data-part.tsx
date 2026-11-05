import type { DataMessagePartComponent } from '@assistant-ui/react';
import { readPersonInput } from './committed-person-input';
import { PersonText } from './user-message-text';

/** The person's message where the running agent read it: their bubble, inside the agent's reply. */
export const PersonInputDataPart: DataMessagePartComponent = ({ data }) => {
  const { images, text } = readPersonInput(data);
  return (
    <div className="flex justify-end py-2" data-testid="person-input">
      <div className="flex max-w-xl flex-col items-end gap-2">
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((src, index) => (
            <img
              alt="Attached"
              className="size-24 rounded-lg object-cover"
              height={96}
              // biome-ignore lint/suspicious/noArrayIndexKey: an input's images never reorder.
              key={index}
              src={src}
              width={96}
            />
          ))}
        </div>
        {text ? (
          <div className="bg-muted max-w-full rounded-2xl px-4 py-2 break-words">
            <PersonText text={text} />
          </div>
        ) : null}
      </div>
    </div>
  );
};
