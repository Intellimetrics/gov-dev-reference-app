package gov.agency.intake;

import java.util.List;
import javax.ejb.*;
import javax.persistence.*;

@Stateless
public class IntakeStatusBean {
  @PersistenceContext(unitName = "intakePU") EntityManager em;

  public List<Object[]> byOrder(String orderBy) {
    return em.createQuery("SELECT i.caseId, i.status FROM IntakeEntity i ORDER BY i." + orderBy).getResultList();
  }

  public Object newCount() {
    return em.createNativeQuery("SELECT COUNT(*) FROM dbo.Intake WHERE Status = 'NEW'").getSingleResult();
  }

  @Schedule(hour = "6", minute = "0", persistent = false)
  public void morningRefresh() { }
}
