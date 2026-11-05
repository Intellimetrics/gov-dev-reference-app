package gov.agency.intake;

import javax.persistence.*;

@Entity
@Table(name = "Intake", schema = "dbo")
@NamedQueries({
  @NamedQuery(name = "Intake.openByType",
              query = "SELECT i.caseId, i.status FROM IntakeEntity i "
                    + "WHERE i.caseType = :type AND i.status <> 'CLOSED'"),
  @NamedQuery(name = "Intake.waitingLong",
              query = "SELECT i FROM IntakeEntity i WHERE i.daysWaiting > :days ORDER BY i.submittedAt")
})
@NamedNativeQuery(name = "Intake.householdBands",
    query = "SELECT HouseholdSize, COUNT(*) AS n FROM dbo.Intake GROUP BY HouseholdSize")
public class IntakeEntity {
  @Id @Column(name = "CaseId") private int caseId;
  @Column(name = "CaseType") private String caseType;
  @Column(name = "Status") private String status;
  @Column(name = "SubmittedAt") private java.sql.Timestamp submittedAt;
  @Column(name = "HouseholdSize") private int householdSize;
  @Column(name = "DaysWaiting") private int daysWaiting;
}
