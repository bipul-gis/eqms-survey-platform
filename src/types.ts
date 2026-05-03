export type FeatureType = 'point' | 'line' | 'polygon';
export type FeatureStatus = 'pending' | 'verified' | 'rejected';

export interface GeoFeature {
  id: string;
  type: FeatureType;
  geometry: any; // GeoJSON geometry
  attributes: Record<string, any>;
  status: FeatureStatus;
  remarks?: string;
  /** Auto-generated backend note for point move operations. */
  moveRemarks?: string;
  /** Auto-generated backend note when a new feature is created. */
  newFeatureRemarks?: string;
  createdBy: string;
  createdByUid?: string;
  updatedBy: string;
  updatedAt: string;
  collectorLocation?: {
    lat: number;
    lng: number;
    accuracy?: number;
  };
}

export interface WardBoundary {
  id: string;
  name: string;
  geometry: any;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  mobileNumber?: string;
  role: 'enumerator' | 'admin';
  status: 'pending' | 'approved' | 'rejected';
  /** Map UI preference: landmark circle marker scale (client-clamped roughly 0.6–2.4). */
  landmarkIconScale?: number;
  /**
   * @deprecated Use `assignedWardNames`. Kept for older user docs.
   */
  assignedWardName?: string | null;
  /**
   * Admin-assigned ward(s) for tasking: feature `Ward_Name` / `WARDNAME` must match one of these
   * (same strings as ward boundary `WARDNAME`, e.g. Ward 01).
   */
  assignedWardNames?: string[];
}

export type QuestionType = 'text' | 'number' | 'select' | 'multiselect' | 'radio' | 'checkbox' | 'date' | 'location';

export interface Question {
  id: string;
  type: QuestionType;
  question: string;
  required: boolean;
  options?: string[]; // For select, multiselect, radio, checkbox
  placeholder?: string;
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface Questionnaire {
  id: string;
  title: string;
  description: string;
  version: string;
  questions: Question[];
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionnaireResponse {
  id: string;
  questionnaireId: string;
  respondentId: string;
  respondentName: string;
  location?: {
    lat: number;
    lng: number;
    ward?: string;
  };
  responses: Record<string, any>; // questionId -> answer
  status: 'draft' | 'submitted' | 'reviewed';
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
}
