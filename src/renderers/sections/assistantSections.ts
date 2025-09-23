import type { ChatMessage } from '../../types';
import { collectCommandRuns, collectFileChanges, collectToolInvocations } from '../data/collectors';
import {
    renderAdditionalDataSection,
    renderCommandRunsSection,
    renderFileChangesSection,
    renderToolInvocationsSection
} from './metadataSections';
import { renderAssistantTextSection } from './textSection';

export function buildAssistantSections(request: ChatMessage): string[] {
    const sections: Array<string | undefined> = [];

    sections.push(renderAssistantTextSection(request));
    sections.push(renderFileChangesSection(collectFileChanges(request)));
    sections.push(renderCommandRunsSection(collectCommandRuns(request)));
    sections.push(renderToolInvocationsSection(collectToolInvocations(request)));
    sections.push(renderAdditionalDataSection(request));

    return sections.filter((section): section is string => Boolean(section && section.trim()));
}
